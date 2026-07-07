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

const SOMI_QTY = process.argv[2] ?? "5";
const LIMIT_PRICE = process.argv[3] ?? "0.30";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const pool = getPool(net.name, "SOMI:USDso");
  const usdso = getToken(net.name, "USDso");

  const c = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, wallet) as SpotPoolContract;
  const usdsoErc = new ethers.Contract(
    usdso.address,
    [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
    ],
    wallet,
  );

  const qtyRaw = ethers.parseEther(SOMI_QTY);
  const priceRaw = ethers.parseUnits(LIMIT_PRICE, usdso.decimals);
  const maxCost = (qtyRaw * priceRaw) / 10n ** 18n;

  // Ensure approval
  const allow: bigint = await (usdsoErc.allowance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(wallet.address, pool.poolAddress);
  if (allow < maxCost) {
    logger.info({ approving: ethers.formatUnits(maxCost * 2n, 18) }, "Approving USDso to SOMI:USDso pool");
    const tx = await (usdsoErc.approve as ethers.BaseContractMethod<
      [string, bigint],
      boolean,
      ethers.ContractTransactionResponse
    >)(pool.poolAddress, maxCost * 10n);
    await tx.wait();
  }

  const expireNs = buildExpireNs(MS_PER_HOUR);
  const args: [boolean, bigint, bigint, bigint, bigint, number, number, string, bigint] = [
    true, // isBid = BUY native SOMI
    0n,
    priceRaw,
    qtyRaw,
    expireNs,
    ORDER_TYPE.ImmediateOrCancel,
    SELF_MATCH.CancelTaker,
    ethers.ZeroAddress,
    0n,
  ];

  const beforeNative = await provider.getBalance(wallet.address);
  const beforeUsdso: bigint = await (usdsoErc.balanceOf as ethers.BaseContractMethod<[string], bigint, bigint>)(wallet.address);

  logger.info(
    {
      qty: SOMI_QTY,
      maxLimit: LIMIT_PRICE,
      maxCostUsdso: ethers.formatUnits(maxCost, 18),
      beforeNative: ethers.formatEther(beforeNative),
      beforeUsdso: ethers.formatUnits(beforeUsdso, 18),
    },
    "Attempting IOC BUY native SOMI",
  );

  try {
    const [simOk, simId] = await c.placeTakerOrderWithoutVault.staticCall(...args, { value: 0n });
    if (!simOk) {
      logger.error({ simId: simId.toString() }, "Sim returned success=false — no external SOMI sellers");
      return;
    }
    const tx = await c.placeTakerOrderWithoutVault(...args, { value: 0n });
    const receipt = await tx.wait();
    logger.info({ txHash: receipt?.hash }, "Broadcast tx mined");

    const afterNative = await provider.getBalance(wallet.address);
    const afterUsdso: bigint = await (usdsoErc.balanceOf as ethers.BaseContractMethod<[string], bigint, bigint>)(wallet.address);
    logger.info(
      {
        gainedSomi: ethers.formatEther(afterNative - beforeNative),
        spentUsdso: ethers.formatUnits(beforeUsdso - afterUsdso, 18),
        afterNative: ethers.formatEther(afterNative),
        afterUsdso: ethers.formatUnits(afterUsdso, 18),
      },
      "✅ SOMI purchased",
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Buy failed");
  }
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
