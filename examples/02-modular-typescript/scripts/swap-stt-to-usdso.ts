/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { logger } from "../src/utils/logger.js";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle, readBookLevels, getErc20 } from "../src/dex/contracts.js";
import {
  buildExpireNs,
  assertExpireNs,
  assertPriceRawNonZero,
  assertBuilderDisabled,
} from "../src/utils/gotchas.js";
import { MS_PER_HOUR, ORDER_TYPE, SELF_MATCH } from "../src/config/constants.js";
import { fromRaw } from "../src/utils/decimals.js";

const POOL_SYMBOL = process.argv[2] ?? "SOMI:USDso";
const STT_TO_SELL = process.argv[3] ?? "1";
const MAX_ATTEMPTS = Number(process.argv[4] ?? "10");
const RETRY_DELAY_MS = 15_000;

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const handle = await getPoolHandle(POOL_SYMBOL);
  const baseDec = handle.baseToken.decimals;
  const qty = ethers.parseUnits(STT_TO_SELL, baseDec);

  const beforeNative = await ctx.provider.getBalance(ctx.wallet.address);
  const usdso = await getErc20(handle.quoteToken.address);
  const beforeUsdso: bigint = await usdso.balanceOf(ctx.wallet.address);

  logger.info(
    {
      pool: POOL_SYMBOL,
      sellQty: STT_TO_SELL,
      beforeNative: fromRaw(beforeNative, 18),
      beforeUsdso: fromRaw(beforeUsdso, handle.quoteToken.decimals),
    },
    "Swap STT → USDso — starting",
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const book = await readBookLevels(handle, 5);
    if (book.bids.length === 0) {
      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS },
        `No resting bids; retrying in ${RETRY_DELAY_MS / 1000}s…`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const topBid = book.bids[0];
    if (!topBid) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    logger.info(
      { topBidPrice: topBid.price, topBidSizeBase: topBid.size, attempt },
      "Resting bids found",
    );

    // Place IOC sell at top bid price (will cross + fill against best bid)
    const priceRaw = topBid.priceRaw;
    const expireNs = buildExpireNs(MS_PER_HOUR);
    assertExpireNs(expireNs);
    assertPriceRawNonZero(priceRaw);
    assertBuilderDisabled(ethers.ZeroAddress, 0n);

    const callArgs: [
      boolean,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
      number,
      string,
      bigint,
    ] = [
      false, // isBid=false → SELL
      0n,
      priceRaw,
      qty,
      expireNs,
      ORDER_TYPE.ImmediateOrCancel,
      SELF_MATCH.CancelTaker,
      ethers.ZeroAddress,
      0n,
    ];

    try {
      const [simSuccess, simOrderId] =
        await handle.contract.placeTakerOrderWithoutVault.staticCall(
          ...callArgs,
          { value: qty },
        );
      if (!simSuccess) {
        logger.warn(
          { attempt },
          `Simulation returned success=false (orderId=${simOrderId}); book likely shifted, retrying…`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      logger.info({ simOrderId: simOrderId.toString() }, "Simulation passed — broadcasting");

      const tx = await handle.contract.placeTakerOrderWithoutVault(...callArgs, {
        value: qty,
      });
      const receipt = await tx.wait();
      logger.info({ txHash: receipt?.hash }, "Taker order tx mined");

      const afterNative = await ctx.provider.getBalance(ctx.wallet.address);
      const afterUsdso: bigint = await usdso.balanceOf(ctx.wallet.address);
      const usdsoGained = afterUsdso - beforeUsdso;
      logger.info(
        {
          gainedUsdso: fromRaw(usdsoGained, handle.quoteToken.decimals),
          afterNative: fromRaw(afterNative, 18),
          afterUsdso: fromRaw(afterUsdso, handle.quoteToken.decimals),
        },
        usdsoGained > 0n
          ? "✅ Swap successful — USDso received"
          : "⚠️ Tx mined but no USDso gained — check book / IOC didn't fill",
      );
      return;
    } catch (err) {
      logger.error({ attempt, err: (err as Error).message }, "Swap attempt failed; retrying");
      await sleep(RETRY_DELAY_MS);
    }
  }

  logger.fatal(`Failed to swap after ${MAX_ATTEMPTS} attempts — book empty too long`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.fatal({ err }, "swap-stt-to-usdso crashed");
  process.exit(1);
});
