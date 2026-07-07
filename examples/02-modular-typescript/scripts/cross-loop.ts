/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { getActiveNetwork } from "../src/config/network.js";
import { getPool } from "../src/config/pairs.js";
import { getToken } from "../src/config/tokens.js";
import { SPOTPOOL_ABI } from "../src/dex/abi/spotpool.js";
import type { SpotPoolContract } from "../src/dex/abi/types.js";
import { buildExpireNs } from "../src/utils/gotchas.js";
import { ORDER_TYPE, SELF_MATCH, MS_PER_HOUR } from "../src/config/constants.js";
import { logger } from "../src/utils/logger.js";

interface BotWallet {
  id: number;
  address: string;
  privateKey: string;
  role: string;
}

const POOL_SYMBOL = process.argv[2] ?? "SOMI:USDso";
const QTY_BASE = process.argv[3] ?? "1";
const SELL_PRICE_QUOTE = process.argv[4] ?? "0.05";
const BUY_PRICE_QUOTE = process.argv[5] ?? "0.30";
const CYCLE_INTERVAL_MS = Number(process.argv[6] ?? "15000");
const MAX_CYCLES = Number(process.argv[7] ?? "100");
const MAKER_WALLET_INDEX = Number(process.argv[8] ?? "3");

const ORDER_PLACED_TOPIC =
  "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";

const ERC20_APPROVE_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

type Direction = "sell" | "buy";

async function main(): Promise<void> {
  const network = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(network.rpc, {
    chainId: network.chainId,
    name: network.name,
  });

  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: BotWallet[];
  };
  const makerEntry = fleet.wallets[MAKER_WALLET_INDEX];
  if (!makerEntry) throw new Error(`MAKER_WALLET_INDEX=${MAKER_WALLET_INDEX} out of range`);
  const takerPriv = process.env.PRIVATE_KEY;
  if (!takerPriv) throw new Error("Set PRIVATE_KEY in .env for taker (registered wallet)");

  const makerWallet = new ethers.Wallet(makerEntry.privateKey, provider);
  const takerWallet = new ethers.Wallet(takerPriv, provider);

  const pool = getPool(network.name, POOL_SYMBOL);
  const baseTok = getToken(network.name, pool.base);
  const quoteTok = getToken(network.name, pool.quote);

  const makerPool = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, makerWallet) as SpotPoolContract;
  const takerPool = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, takerWallet) as SpotPoolContract;

  const qtyRaw = ethers.parseUnits(QTY_BASE, baseTok.decimals);
  const sellPriceRaw = ethers.parseUnits(SELL_PRICE_QUOTE, quoteTok.decimals);
  const buyPriceRaw = ethers.parseUnits(BUY_PRICE_QUOTE, quoteTok.decimals);
  const maxCost = qtyRaw * (sellPriceRaw > buyPriceRaw ? sellPriceRaw : buyPriceRaw) / 10n ** BigInt(baseTok.decimals);
  const costPerCycle = maxCost;

  // For "buy" direction, taker needs USDso allowance
  if (!baseTok.isNative) {
    logger.warn("Base token is not native — buy direction not yet implemented for ERC20 base");
  }
  const usdsoErc = new ethers.Contract(quoteTok.address, ERC20_APPROVE_ABI, takerWallet);
  const currentAllowance: bigint = await (usdsoErc.allowance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(takerWallet.address, pool.poolAddress);
  if (currentAllowance < costPerCycle * 100n) {
    const approveAmount = costPerCycle * 1000n;
    logger.info(
      { approveAmount: approveAmount.toString() },
      "Approving USDso to pool for taker (covers many buy cycles)",
    );
    const tx = await (usdsoErc.approve as ethers.BaseContractMethod<
      [string, bigint],
      boolean,
      ethers.ContractTransactionResponse
    >)(pool.poolAddress, approveAmount);
    await tx.wait();
  }

  logger.info(
    {
      pool: POOL_SYMBOL,
      maker: makerWallet.address,
      taker: takerWallet.address,
      qty: QTY_BASE,
      sellPrice: SELL_PRICE_QUOTE,
      buyPrice: BUY_PRICE_QUOTE,
      costPerCycleRaw: costPerCycle.toString(),
      cycleMs: CYCLE_INTERVAL_MS,
      maxCycles: MAX_CYCLES,
    },
    "Bidirectional cross-loop starting",
  );

  let totalVolumeRaw = 0n;
  let cycle = 0;
  let stopped = false;
  let direction: Direction = "sell";
  let directionSwitches = 0;
  let consecutiveSwitches = 0;

  process.on("SIGINT", () => { stopped = true; logger.warn("SIGINT — stopping after cycle"); });
  process.on("SIGTERM", () => { stopped = true; logger.warn("SIGTERM — stopping after cycle"); });

  for (cycle = 1; cycle <= MAX_CYCLES && !stopped; cycle += 1) {
    const makerUsdso: bigint = await makerPool.getWithdrawableBalance(makerWallet.address, quoteTok.address);
    const makerBase: bigint = await makerPool.getWithdrawableBalance(makerWallet.address, baseTok.address);
    const takerNative = await provider.getBalance(takerWallet.address);
    const erc20Read = new ethers.Contract(
      quoteTok.address,
      ["function balanceOf(address) view returns (uint256)"],
      provider,
    );
    const takerUsdsoBal: bigint = await (erc20Read.balanceOf as ethers.BaseContractMethod<
      [string],
      bigint,
      bigint
    >)(takerWallet.address);

    const sellBlocked = makerUsdso < costPerCycle || (baseTok.isNative && takerNative < qtyRaw + ethers.parseEther("0.05"));
    const buyBlocked = makerBase < qtyRaw || takerUsdsoBal < costPerCycle;
    if (sellBlocked && buyBlocked) {
      logger.error(
        {
          cycle,
          makerUsdso: ethers.formatUnits(makerUsdso, quoteTok.decimals),
          makerBase: ethers.formatUnits(makerBase, baseTok.decimals),
          takerNative: ethers.formatEther(takerNative),
          takerUsdsoBal: ethers.formatUnits(takerUsdsoBal, quoteTok.decimals),
        },
        "BOTH directions blocked — capital exhausted, stopping loop",
      );
      break;
    }
    if (direction === "sell" && sellBlocked) {
      direction = "buy";
      directionSwitches += 1;
      consecutiveSwitches += 1;
      logger.warn({ cycle }, "Switching direction → BUY (W3 sells SOMI vault, Reg IOC BUY)");
      if (consecutiveSwitches >= 2) {
        logger.error({ consecutiveSwitches }, "Direction thrashing detected — stopping");
        break;
      }
      continue;
    }
    if (direction === "buy" && buyBlocked) {
      direction = "sell";
      directionSwitches += 1;
      consecutiveSwitches += 1;
      logger.warn({ cycle }, "Switching direction → SELL (W3 BID, Reg IOC SELL)");
      if (consecutiveSwitches >= 2) {
        logger.error({ consecutiveSwitches }, "Direction thrashing detected — stopping");
        break;
      }
      continue;
    }
    consecutiveSwitches = 0;

    logger.info(
      {
        cycle,
        direction,
        makerVaultUsdso: ethers.formatUnits(makerUsdso, quoteTok.decimals),
        makerVaultBase: ethers.formatUnits(makerBase, baseTok.decimals),
        takerNative: ethers.formatEther(takerNative),
        takerUsdsoBal: ethers.formatUnits(takerUsdsoBal, quoteTok.decimals),
        totalVolume: ethers.formatUnits(totalVolumeRaw, quoteTok.decimals),
      },
      "=== CYCLE START ===",
    );

    const priceRaw = direction === "sell" ? sellPriceRaw : buyPriceRaw;
    try {
      const result = await runOneCycle({
        direction,
        makerPool,
        takerPool,
        makerAddress: makerWallet.address,
        takerAddress: takerWallet.address,
        priceRaw,
        qtyRaw,
        baseIsNative: baseTok.isNative ?? false,
      });
      if (result.filledQty > 0n) {
        const cycleVolume = (result.filledQty * priceRaw) / 10n ** BigInt(baseTok.decimals);
        totalVolumeRaw += cycleVolume;
        logger.info(
          {
            cycle,
            direction,
            filledQty: ethers.formatUnits(result.filledQty, baseTok.decimals),
            cycleVolume: ethers.formatUnits(cycleVolume, quoteTok.decimals),
            totalVolume: ethers.formatUnits(totalVolumeRaw, quoteTok.decimals),
            txs: [result.makerTxHash, result.takerTxHash],
          },
          "✓ Cycle filled",
        );
      } else {
        logger.warn({ cycle, direction }, "✗ Cycle did NOT fill");
      }
    } catch (err) {
      logger.error({ cycle, direction, err: (err as Error).message }, "Cycle failed");
    }

    if (cycle < MAX_CYCLES && !stopped) {
      await sleep(CYCLE_INTERVAL_MS);
    }
  }

  logger.info(
    {
      cyclesRun: cycle - 1,
      directionSwitches,
      totalVolume: ethers.formatUnits(totalVolumeRaw, quoteTok.decimals),
    },
    "Bidirectional cross-loop finished",
  );
}

interface CycleParams {
  direction: Direction;
  makerPool: SpotPoolContract;
  takerPool: SpotPoolContract;
  makerAddress: string;
  takerAddress: string;
  priceRaw: bigint;
  qtyRaw: bigint;
  baseIsNative: boolean;
}

interface CycleResult {
  filledQty: bigint;
  makerTxHash: string;
  takerTxHash: string;
}

async function runOneCycle(p: CycleParams): Promise<CycleResult> {
  const expireNs = buildExpireNs(MS_PER_HOUR);
  const makerIsBid = p.direction === "sell"; // sell direction: maker places BID

  const makerArgs: [boolean, bigint, bigint, bigint, bigint, number, number, string, bigint] = [
    makerIsBid,
    0n,
    p.priceRaw,
    p.qtyRaw,
    expireNs,
    ORDER_TYPE.PostOnly,
    SELF_MATCH.CancelTaker,
    ethers.ZeroAddress,
    0n,
  ];

  const [simOk, simId] = await p.makerPool.placeOrder.staticCall(...makerArgs);
  if (!simOk) {
    throw new Error(`Maker order sim failed (direction=${p.direction}): orderId=${simId}`);
  }
  const makerTx = await p.makerPool.placeOrder(...makerArgs);
  const makerReceipt = await makerTx.wait();
  if (!makerReceipt) throw new Error("Maker receipt null");

  let makerOrderId = simId;
  for (const log of makerReceipt.logs) {
    if (log.topics[0] === ORDER_PLACED_TOPIC && log.topics[1]) {
      makerOrderId = BigInt(log.topics[1]);
      break;
    }
  }

  // Taker side
  const takerIsBid = !makerIsBid;
  const takerArgs: [boolean, bigint, bigint, bigint, bigint, number, number, string, bigint] = [
    takerIsBid,
    0n,
    p.priceRaw,
    p.qtyRaw,
    expireNs,
    ORDER_TYPE.ImmediateOrCancel,
    SELF_MATCH.CancelTaker,
    ethers.ZeroAddress,
    0n,
  ];

  // For native base: when taker SELLS native (isBid=false), msg.value = qty
  const value = p.baseIsNative && !takerIsBid ? p.qtyRaw : 0n;

  const [simTokOk, simTokId] = await p.takerPool.placeTakerOrderWithoutVault.staticCall(
    ...takerArgs,
    { value },
  );
  if (!simTokOk) {
    logger.warn({ simTokId: simTokId.toString() }, "Taker sim returned false — cancelling maker order");
    try {
      const cancelTx = await p.makerPool.cancelOrder(makerOrderId);
      await cancelTx.wait();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Cleanup cancel failed");
    }
    return { filledQty: 0n, makerTxHash: makerReceipt.hash, takerTxHash: "" };
  }

  const takerTx = await p.takerPool.placeTakerOrderWithoutVault(...takerArgs, { value });
  const takerReceipt = await takerTx.wait();
  if (!takerReceipt) throw new Error("Taker receipt null");

  const ORDER_FILLED_TOPIC = ethers.id(
    "OrderFilled(uint128,uint128,uint256,uint256,uint256)",
  );
  let filledQty = 0n;
  for (const log of takerReceipt.logs) {
    if (log.topics[0] === ORDER_FILLED_TOPIC) {
      const dataHex = log.data.replace(/^0x/, "");
      const qtyHex = dataHex.slice(0, 64);
      filledQty += BigInt("0x" + qtyHex);
    }
  }

  return { filledQty, makerTxHash: makerReceipt.hash, takerTxHash: takerReceipt.hash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.fatal({ err: err.message ?? err });
  process.exit(1);
});
