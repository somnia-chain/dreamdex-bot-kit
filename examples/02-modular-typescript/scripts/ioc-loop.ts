/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { getActiveNetwork } from "../src/config/network.js";
import { getPool } from "../src/config/pairs.js";
import { getToken } from "../src/config/tokens.js";
import { SPOTPOOL_ABI } from "../src/dex/abi/spotpool.js";
import type { SpotPoolContract } from "../src/dex/abi/types.js";
import { buildExpireNs } from "../src/utils/gotchas.js";
import { ORDER_TYPE, SELF_MATCH, MS_PER_HOUR } from "../src/config/constants.js";
import { logger } from "../src/utils/logger.js";

const POOL_SYMBOL = process.argv[2] ?? "WETH:USDso";
const QTY_BASE = process.argv[3] ?? "0.001";
const BUY_PRICE = process.argv[4] ?? "5000";
const SELL_PRICE = process.argv[5] ?? "1";
const CYCLE_INTERVAL_MS = Number(process.argv[6] ?? "8000");
const MAX_CYCLES = Number(process.argv[7] ?? "60");
// Optional USDso hysteresis guard: when wallet USDso drops below FLOOR, force
// SELL-only until it recovers above CEILING. Prevents drift draining USDso to
// the PnL floor on ASK-heavy pools. 0 = disabled (default).
const USDSO_FLOOR = Number(process.argv[8] ?? "0");
const USDSO_CEILING = Number(process.argv[9] ?? "0");

const ORDER_FILLED_TOPIC = ethers.id(
  "OrderFilled(uint128,uint128,uint256,uint256,uint256)",
);

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, {
    chainId: net.chainId,
    name: net.name,
  });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const pool = getPool(net.name, POOL_SYMBOL);
  const baseTok = getToken(net.name, pool.base);
  const quoteTok = getToken(net.name, pool.quote);

  const c = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, wallet) as SpotPoolContract;
  const baseErc = new ethers.Contract(baseTok.address, ERC20_ABI, wallet);
  const quoteErc = new ethers.Contract(quoteTok.address, ERC20_ABI, wallet);

  const qtyRaw = ethers.parseUnits(QTY_BASE, baseTok.decimals);
  const buyPriceRaw = ethers.parseUnits(BUY_PRICE, quoteTok.decimals);
  const sellPriceRaw = ethers.parseUnits(SELL_PRICE, quoteTok.decimals);

  // Ensure approvals (USDso + base token to pool) — one-time setup
  const usdsoApprove = (qtyRaw * buyPriceRaw) / 10n ** BigInt(baseTok.decimals) * 1000n;
  const baseApprove = qtyRaw * 1000n;
  const usdsoAllow: bigint = await (quoteErc.allowance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(wallet.address, pool.poolAddress);
  if (usdsoAllow < usdsoApprove / 100n) {
    logger.info({ amount: ethers.formatUnits(usdsoApprove, quoteTok.decimals) }, "Approving USDso to pool");
    const tx = await (quoteErc.approve as ethers.BaseContractMethod<
      [string, bigint],
      boolean,
      ethers.ContractTransactionResponse
    >)(pool.poolAddress, usdsoApprove);
    await tx.wait();
  }
  const baseAllow: bigint = await (baseErc.allowance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(wallet.address, pool.poolAddress);
  if (baseAllow < baseApprove / 100n) {
    logger.info({ amount: ethers.formatUnits(baseApprove, baseTok.decimals) }, `Approving ${baseTok.symbol} to pool`);
    const tx = await (baseErc.approve as ethers.BaseContractMethod<
      [string, bigint],
      boolean,
      ethers.ContractTransactionResponse
    >)(pool.poolAddress, baseApprove);
    await tx.wait();
  }

  logger.info(
    {
      pool: POOL_SYMBOL,
      qty: QTY_BASE,
      buyLimit: BUY_PRICE,
      sellLimit: SELL_PRICE,
      cycleMs: CYCLE_INTERVAL_MS,
      maxCycles: MAX_CYCLES,
    },
    "IOC loop starting — IOC-taker alternator",
  );

  let totalVolumeRaw = 0n;
  let successfulFills = 0;
  let attempts = 0;
  let stopped = false;
  let lastCycleNum = 0;
  process.on("SIGINT", () => { stopped = true; logger.warn("SIGINT received"); });
  process.on("SIGTERM", () => { stopped = true; logger.warn("SIGTERM received"); });

  // Heartbeat — log every 30s so a frozen loop is immediately visible
  const heartbeat = setInterval(() => {
    logger.info(
      { cycle: lastCycleNum, successes: successfulFills, totalVolume: ethers.formatUnits(totalVolumeRaw, 18) },
      "♥ heartbeat",
    );
  }, 30000);

  // Start with BUY (might need to bootstrap base balance)
  let nextSide: "buy" | "sell" = "buy";
  let sellOnlyMode = false; // hysteresis guard state (see USDSO_FLOOR/CEILING)

  for (let cycle = 1; cycle <= MAX_CYCLES && !stopped; cycle += 1) {
    lastCycleNum = cycle;
    const cycleStart = Date.now();
    attempts += 1;

    // Gas pre-flight: native SOMI is fuel for every broadcast.
    const nativeBal = await provider.getBalance(wallet.address);
    if (nativeBal < ethers.parseUnits("0.5", 18)) {
      logger.error(
        { cycle, nativeSomi: ethers.formatUnits(nativeBal, 18) },
        "Gas SOMI critical (<0.5) — aborting loop, refuel needed",
      );
      break;
    }
    const usdsoBal: bigint = await (quoteErc.balanceOf as ethers.BaseContractMethod<[string], bigint, bigint>)(wallet.address);
    const baseBal: bigint = await (baseErc.balanceOf as ethers.BaseContractMethod<[string], bigint, bigint>)(wallet.address);

    // USDso hysteresis guard: force SELL-only below FLOOR until recovered above CEILING.
    if (USDSO_FLOOR > 0) {
      const usdsoHuman = Number(ethers.formatUnits(usdsoBal, 18));
      if (!sellOnlyMode && usdsoHuman < USDSO_FLOOR) {
        sellOnlyMode = true;
        logger.warn({ cycle, usdso: usdsoHuman.toFixed(2), floor: USDSO_FLOOR }, "Guard: USDso below floor → SELL-only mode");
      } else if (sellOnlyMode && usdsoHuman >= USDSO_CEILING) {
        sellOnlyMode = false;
        logger.info({ cycle, usdso: usdsoHuman.toFixed(2), ceiling: USDSO_CEILING }, "Guard: USDso recovered → resume alternating");
      }
      if (sellOnlyMode) nextSide = "sell";
    }

    if (nextSide === "buy") {
      const need = (qtyRaw * buyPriceRaw) / 10n ** BigInt(baseTok.decimals);
      if (usdsoBal < need) {
        logger.warn({ cycle, usdsoBal: ethers.formatUnits(usdsoBal, 18) }, "Insufficient USDso for BUY — switching to SELL");
        nextSide = "sell";
        continue;
      }
    } else {
      if (baseBal < qtyRaw) {
        logger.warn({ cycle, baseBal: ethers.formatUnits(baseBal, baseTok.decimals) }, `Insufficient ${baseTok.symbol} for SELL — switching to BUY`);
        nextSide = "buy";
        continue;
      }
    }

    const isBid: boolean = nextSide === "buy";
    const priceRaw = isBid ? buyPriceRaw : sellPriceRaw;
    const expireNs = buildExpireNs(MS_PER_HOUR);
    const args: [boolean, bigint, bigint, bigint, bigint, number, number, string, bigint] = [
      isBid,
      0n,
      priceRaw,
      qtyRaw,
      expireNs,
      ORDER_TYPE.ImmediateOrCancel,
      SELF_MATCH.CancelTaker,
      ethers.ZeroAddress,
      0n,
    ];

    logger.info(
      {
        cycle,
        side: nextSide,
        qty: QTY_BASE,
        limit: isBid ? BUY_PRICE : SELL_PRICE,
        attempts,
        successes: successfulFills,
        totalVolume: ethers.formatUnits(totalVolumeRaw, 18),
      },
      `Attempting IOC ${nextSide.toUpperCase()}`,
    );

    try {
      const [simOk, simId] = await withTimeout(
        c.placeTakerOrderWithoutVault.staticCall(...args, { value: 0n }),
        15000,
        "sim",
      );
      if (!simOk) {
        logger.info({ cycle, simId: simId.toString() }, "No external liquidity — IOC sim returns false, skipping");
        // Try other side next
        nextSide = isBid ? "sell" : "buy";
        await sleep(CYCLE_INTERVAL_MS);
        continue;
      }

      const tx = await withTimeout(
        c.placeTakerOrderWithoutVault(...args, { value: 0n }),
        30000,
        "broadcast",
      );
      const receipt = await withTimeout(tx.wait(), 60000, "tx.wait");
      if (!receipt) {
        logger.warn({ cycle, txHash: tx.hash }, "Null receipt");
        continue;
      }

      let filledQty = 0n;
      let executedVolumeRaw = 0n;
      for (const log of receipt.logs) {
        if (log.topics[0] === ORDER_FILLED_TOPIC) {
          const dataHex = log.data.replace(/^0x/, "");
          const qtyFilled = BigInt("0x" + dataHex.slice(0, 64));
          filledQty += qtyFilled;
          // executedVolumeRaw approximated as qty × limit price; actual could differ if fills at better
          executedVolumeRaw += (qtyFilled * priceRaw) / 10n ** BigInt(baseTok.decimals);
        }
      }

      if (filledQty > 0n) {
        successfulFills += 1;
        totalVolumeRaw += executedVolumeRaw;
        logger.info(
          {
            cycle,
            side: nextSide,
            filledQty: ethers.formatUnits(filledQty, baseTok.decimals),
            txHash: receipt.hash,
            totalVolume: ethers.formatUnits(totalVolumeRaw, 18),
            successes: successfulFills,
          },
          `✓ IOC ${nextSide.toUpperCase()} filled`,
        );
      } else {
        logger.warn({ cycle, txHash: receipt.hash }, "IOC tx succeeded but no fill events");
      }

      // Toggle side for next cycle
      nextSide = isBid ? "sell" : "buy";
    } catch (err) {
      logger.error({ cycle, err: (err as Error).message }, "IOC cycle failed");
    }

    const cycleDur = Date.now() - cycleStart;
    if (cycleDur > 10000) {
      logger.warn({ cycle, durMs: cycleDur }, "Slow cycle (>10s body time) — RPC may be lagging");
    }

    if (cycle < MAX_CYCLES && !stopped) await sleep(CYCLE_INTERVAL_MS);
  }

  clearInterval(heartbeat);
  logger.info(
    {
      attempts,
      successfulFills,
      successRate: attempts > 0 ? `${((successfulFills / attempts) * 100).toFixed(0)}%` : "n/a",
      totalVolume: ethers.formatUnits(totalVolumeRaw, 18),
    },
    "IOC loop finished",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Defensive timeout wrapper — prevents indefinite hangs when ethers' tx.wait()
// or RPC calls lose response. On timeout, the cycle's try/catch logs the error
// and the loop continues to the next iteration.
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms)),
  ]);
}

main().catch((err) => {
  logger.fatal({ err: err.message ?? err });
  process.exit(1);
});
