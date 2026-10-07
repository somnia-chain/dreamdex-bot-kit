/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// perp-funding: takes whichever side funding pays, and steps aside when the
// rate stops being worth it.
//
// Funding is paid between traders, not to the protocol, so a carry position
// earns the rate for as long as it is held on the paying side. This bot has no
// view on price at all: it holds the side that is being paid, sized to a cap,
// and closes when the rate falls through the exit threshold.
//
// The risk it does NOT hedge is the obvious one. A carry position is fully
// exposed to the mark, and a single adverse move can cost more than weeks of
// funding. PERP_FUNDING_MAX_POSITION_USDSO is what bounds that.
//
//   npm run dev -w perp-funding

import {
  ORDER_TYPE,
  closePosition,
  createExchange,
  ensureLeverage,
  envNum,
  loadEnv,
  fundingApr,
  liveMark,
  markOf,
  onStop,
  placePerp,
  positionIn,
  preflight,
  requireMarket,
  shutdown,
  sizeForNotional,
  sizeOrder,
  sleep,
  tradingKeyCheck,
} from "@dreamdex-bot-kit/perp-core";

// Read .env BEFORE the constants below are evaluated. ES modules evaluate
// top-level bindings at import time, which is earlier than any call inside
// main(), so a config read here would otherwise always see the defaults.
loadEnv();
const LEVERAGE = envNum("PERP_FUNDING_LEVERAGE", 2);
const MIN_APR = envNum("PERP_FUNDING_MIN_APR", 0.1);
const EXIT_APR = envNum("PERP_FUNDING_EXIT_APR", 0.03);
const NOTIONAL = envNum("PERP_FUNDING_NOTIONAL_USDSO", 50);
const MAX_POSITION = envNum("PERP_FUNDING_MAX_POSITION_USDSO", 200);
const POLL_MS = envNum("PERP_FUNDING_POLL_MS", 60_000);

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: live });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, ctx.config.symbol || "BTC-PERP");
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;

  if (EXIT_APR > MIN_APR) {
    throw new Error(
      `PERP_FUNDING_EXIT_APR (${EXIT_APR}) is above PERP_FUNDING_MIN_APR (${MIN_APR}), which would open a ` +
        "position and close it on the next poll. Set the exit below the entry.",
    );
  }

  console.log(
    `perp-funding on ${market.display} | enter above ${(MIN_APR * 100).toFixed(2)}% APR, exit below ` +
      `${(EXIT_APR * 100).toFixed(2)}% | ${NOTIONAL} USDso per entry at ${LEVERAGE}x, cap ${MAX_POSITION} | ` +
      `dry-run ${ctx.config.dryRun}`,
  );

  if (me) {
    const link = await tradingKeyCheck(ctx, market);
    if (link.message) console.log(link.message);
    if (!link.ok && live) process.exit(1);
    const check = await preflight(ctx.exchange, market, me, { requiredUsdso: NOTIONAL / Math.max(1, LEVERAGE) });
    console.log(check.message);
    if (!check.ok) process.exit(1);
    const lev = await ensureLeverage(ctx, market, me, LEVERAGE);
    if (lev.ownerOnly) {
      console.log(`leverage on ${market.display} is ${lev.from ? `${lev.from}x` : "unset"} for this account; a trading key cannot change it, set it in the app.`);
    }
  }

  while (!stopped()) {
    // Re-read the market row each cycle: funding is a market-level number that
    // moves under a bot that caches it.
    const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
    const funding = fundingApr(fresh.info);
    const position = me ? await positionIn(ctx.exchange, fresh) : undefined;
    const liveAt = (await liveMark(ctx.exchange, fresh)) ?? markOf(fresh.info);
    const held = position ? position.contracts * liveAt : 0;

    console.log(
      `funding ${(funding.apr * 100).toFixed(3)}% APR, paying ${funding.paidSide}s | ` +
        `holding ${position ? `${position.side} ${held.toFixed(2)} USDso` : "nothing"}`,
    );

    const worthHolding = Math.abs(funding.apr) >= MIN_APR;
    const worthKeeping = Math.abs(funding.apr) >= EXIT_APR;

    if (position && (!worthKeeping || position.side !== funding.paidSide)) {
      // Either the rate stopped paying, or it flipped and the position is now
      // on the side that PAYS. Both mean close, and a flip means close before
      // opening the other way rather than netting through a bigger order.
      const why = !worthKeeping ? "rate fell through the exit threshold" : "funding flipped against this side";
      console.log(`closing: ${why}`);
      if (me) await closePosition(ctx, fresh, me, { label: "carry exit" });
    } else if (!position && worthHolding && me) {
      if (held >= MAX_POSITION) {
        console.log("at the position cap, not adding");
      } else {
        const side = funding.paidSide;
        const book = await ctx.exchange.fetchOrderBook(fresh.symbol, 1);
        const touch = side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
        if (touch === undefined) {
          console.log("no counterparty resting, waiting");
        } else {
          const price = BigInt(Math.round(touch * 1e18));
          const wanted = sizeForNotional(Math.min(NOTIONAL, MAX_POSITION), fresh.info, liveAt);
          const sized = await sizeOrder(ctx.exchange, {
            market: fresh,
            account: me,
            side,
            price,
            wanted,
            autoPull: true,
            tradingKey: ctx.tradingKey,
          });
          if (!sized.ok) console.log(`entry skipped: ${sized.reason}`);
          else await placePerp({ ctx, market: fresh, side, price, quantity: sized.quantity, orderType: ORDER_TYPE.MARKET, label: "carry entry" });
        }
      }
    }

    await sleep(POLL_MS, stopped);
  }

  console.log("stopped. The position is left open deliberately: closing it on exit would realise PnL nobody asked to realise.");
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
