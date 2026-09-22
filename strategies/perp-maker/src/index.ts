/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// perp-maker: rests a bid and an ask around the mark and skews them to stay
// flat. It quotes, waits, and re-quotes when the mark has moved far enough to
// matter; it does not chase every tick.
//
//   • both sides are sized by the pool, so a quote is never larger than the
//     account can actually back
//   • inventory skews the quotes rather than cancelling one side: leaning long
//     pushes the bid away and pulls the ask in, which is what gets filled back
//     to flat
//   • the position cap is on NOTIONAL, so it means the same thing on a 100k
//     market as on a 1 dollar one
//
//   npm run dev -w perp-maker

import {
  ORDER_TYPE,
  cancelQuietly,
  createExchange,
  ensureLeverage,
  envNum,
  loadEnv,
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
  type PerpMarket,
} from "@dreamdex-bot-kit/perp-core";

// Read .env BEFORE the constants below are evaluated. ES modules evaluate
// top-level bindings at import time, which is earlier than any call inside
// main(), so a config read here would otherwise always see the defaults.
loadEnv();
const LEVERAGE = envNum("PERP_MM_LEVERAGE", 2);
const HALF_SPREAD_BPS = envNum("PERP_MM_HALF_SPREAD_BPS", 15);
const NOTIONAL = envNum("PERP_MM_NOTIONAL_USDSO", 25);
const MAX_POSITION = envNum("PERP_MM_MAX_POSITION_USDSO", 100);
const SKEW_BPS = envNum("PERP_MM_INVENTORY_SKEW_BPS", 10);
const REQUOTE_BPS = envNum("PERP_MM_REQUOTE_TRIGGER_BPS", 8);
const REFRESH_MS = envNum("PERP_MM_REFRESH_MS", 15_000);

interface Quote {
  bid?: bigint;
  ask?: bigint;
  atMark: number;
}

/** Notional of the current position, signed: positive is long. */
async function inventoryUsdso(ctx: ReturnType<typeof createExchange>, market: PerpMarket): Promise<number> {
  const position = await positionIn(ctx.exchange, market);
  if (!position) return 0;
  const signed = position.side === "long" ? position.contracts : -position.contracts;
  return signed * markOf(market.info);
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: live });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, ctx.config.symbol || "BTC-PERP");
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;

  console.log(
    `perp-maker on ${market.display} | ${NOTIONAL} USDso per side at ${LEVERAGE}x | ` +
      `half-spread ${HALF_SPREAD_BPS}bps skew ${SKEW_BPS}bps | cap ${MAX_POSITION} USDso | dry-run ${ctx.config.dryRun}`,
  );

  if (me) {
    const check = await preflight(ctx.exchange, market, me, { requiredUsdso: (NOTIONAL * 2) / Math.max(1, LEVERAGE) });
    console.log(check.message);
    if (!check.ok) process.exit(1);
    await ensureLeverage(ctx, market, me, LEVERAGE);
  }

  let resting: Quote = { atMark: 0 };

  while (!stopped()) {
    // Same snapshot trap as everywhere else: the row has to be re-read, or the
    // quote is centred on the mark this process started with.
    const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
    // Quote around the mark the pool acts on. The row's copy lags by tens of
    // minutes, which on a quiet market is a quote sitting where nobody trades.
    const mark = (await liveMark(ctx.exchange, fresh)) ?? 0;
    if (!(mark > 0)) {
      console.log("market is un-priceable right now, holding off this cycle");
      await sleep(REFRESH_MS, stopped);
      continue;
    }

    // Re-quote only when the mark has moved past the trigger. Cancelling and
    // replacing on every cycle burns gas and loses queue position for nothing.
    const drift = resting.atMark > 0 ? Math.abs(mark - resting.atMark) / resting.atMark * 10_000 : Infinity;
    if (drift < REQUOTE_BPS) {
      await sleep(REFRESH_MS, stopped);
      continue;
    }

    if (resting.bid || resting.ask) {
      for (const id of [resting.bid, resting.ask]) {
        if (id !== undefined) await cancelQuietly(ctx, market, id);
      }
      resting = { atMark: 0 };
    }

    const inventory = me ? await inventoryUsdso(ctx, fresh) : 0;
    // Leaning long: push the bid down and pull the ask in, so the ask fills
    // first and brings the book back to flat.
    const lean = MAX_POSITION > 0 ? Math.max(-1, Math.min(1, inventory / MAX_POSITION)) : 0;
    const skew = (SKEW_BPS / 10_000) * lean;
    const half = HALF_SPREAD_BPS / 10_000;
    const bidPx = BigInt(Math.round(mark * (1 - half - skew) * 1e18));
    const askPx = BigInt(Math.round(mark * (1 + half - skew) * 1e18));

    const wanted = sizeForNotional(NOTIONAL, fresh.info, mark);
    const next: Quote = { atMark: mark };

    // If one leg throws after the other is already resting, pull the placed leg
    // before the error propagates: a bot that exits here would otherwise leave a
    // one-sided quote trading on the book with nobody watching it.
    try {
      for (const [side, price] of [["long", bidPx] as const, ["short", askPx] as const]) {
        // Do not add to a side that is already at the cap. The other side stays
        // quoted, which is how the position comes back rather than getting stuck.
        const wouldExceed = side === "long" ? inventory >= MAX_POSITION : inventory <= -MAX_POSITION;
        if (wouldExceed) {
          console.log(`${side} side held back: inventory ${inventory.toFixed(2)} USDso is at the cap`);
          continue;
        }
        const sized = me
          ? await sizeOrder(ctx.exchange, { market: fresh, account: me, side, price, wanted })
          : { ok: true as const, quantity: wanted };
        if (!sized.ok) {
          console.log(`${side} side skipped: ${sized.reason}`);
          continue;
        }
        const placed = await placePerp({
          ctx,
          market: fresh,
          side,
          price,
          quantity: sized.quantity,
          orderType: ORDER_TYPE.POST_ONLY,
          label: "quote",
        });
        if (side === "long") next.bid = placed.orderId;
        else next.ask = placed.orderId;
      }
    } catch (err) {
      for (const id of [next.bid, next.ask]) {
        if (id !== undefined) await cancelQuietly(ctx, market, id);
      }
      throw err;
    }

    resting = next;
    await sleep(REFRESH_MS, stopped);
  }

  // Leaving quotes on the book after the process exits is how a stopped bot
  // keeps trading.
  for (const id of [resting.bid, resting.ask]) {
    if (id !== undefined) await cancelQuietly(ctx, market, id);
  }
  console.log("quotes pulled, exiting");
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
