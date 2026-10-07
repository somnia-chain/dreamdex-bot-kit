/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// perp-guard: not a trader. It watches margin health and reduces a position
// before the protocol does it for you.
//
// Liquidation is not a cliff on this venue, it is a waterfall, and the first
// stage closes on the order book at whatever the book will pay, then charges a
// fee out of any surplus. Reducing earlier, voluntarily, is cheaper than being
// reduced at the maintenance line.
//
// Health here is equity over the MAINTENANCE requirement, so 1.0 is the
// liquidation line and 2.0 is twice the cushion the protocol demands. An
// account with no position reads Infinity, which is the honest answer and never
// triggers anything.
//
//   PERP_GUARD_REDUCE_BELOW=1.5   start reducing under this ratio
//   PERP_GUARD_REDUCE_PCT=25      close this much of the position each time
//   PERP_GUARD_FLATTEN_BELOW=1.15 close everything under this ratio
//
//   npm run dev -w perp-guard

import {
  closePosition,
  createExchange,
  envNum,
  loadEnv,
  healthRatio,
  marginSnapshot,
  liveMark,
  markOf,
  onStop,
  perpMarkets,
  positionIn,
  requireMarket,
  shutdown,
  sleep,
  tradingKeyCheck,
  type PerpMarket,
} from "@dreamdex-bot-kit/perp-core";

// Read .env BEFORE the constants below are evaluated. ES modules evaluate
// top-level bindings at import time, which is earlier than any call inside
// main(), so a config read here would otherwise always see the defaults.
loadEnv();
const REDUCE_BELOW = envNum("PERP_GUARD_REDUCE_BELOW", 1.5);
const REDUCE_PCT = envNum("PERP_GUARD_REDUCE_PCT", 25);
const FLATTEN_BELOW = envNum("PERP_GUARD_FLATTEN_BELOW", 1.15);
const POLL_MS = envNum("PERP_GUARD_POLL_MS", 30_000);

/**
 * The markets to watch.
 *
 * A blank PERP_SYMBOL means every market the account actually has exposure in,
 * which is the shape that matters here: margin is cross, so a position in one
 * market can be liquidated to cover another, and watching one market in
 * isolation misses that entirely.
 *
 * Halted markets are kept deliberately. The live-market filter drops a market
 * the venue has stopped, which is exactly when a guard is worth having: a
 * position on it still carries margin, and reducing orders are still accepted
 * while a market is un-priceable. Filtering on `active` here would blind the
 * guard at the only moment it matters, so the watch list is built from what the
 * ACCOUNT holds rather than from what the venue is currently quoting.
 */
async function watchList(ctx: ReturnType<typeof createExchange>, account?: `0x${string}`): Promise<PerpMarket[]> {
  if (ctx.config.symbol) {
    return [await requireMarket(ctx.exchange, ctx.config.symbol, { includeHalted: true })];
  }
  if (!account) return perpMarkets(ctx.exchange);
  const positions = await ctx.exchange.fetchPositions();
  const held = new Set(positions.map((p) => p.symbol));
  const all = await perpMarkets(ctx.exchange, false, { includeHalted: true });
  return all.filter((m) => held.has(m.symbol));
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: live });
  const stopped = onStop();
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;

  if (FLATTEN_BELOW > REDUCE_BELOW) {
    throw new Error(
      `PERP_GUARD_FLATTEN_BELOW (${FLATTEN_BELOW}) is above PERP_GUARD_REDUCE_BELOW (${REDUCE_BELOW}), so the ` +
        "guard would flatten before it ever reduced. Set the flatten threshold below the reduce one.",
    );
  }

  console.log(
    `perp-guard | reduce ${REDUCE_PCT}% below ${REDUCE_BELOW}x maintenance, flatten below ${FLATTEN_BELOW}x | ` +
      `dry-run ${ctx.config.dryRun}`,
  );
  if (!me) {
    console.log("read-only: no PRIVATE_KEY, so health is reported but nothing is closed.");
  } else {
    // The app links a trading key on every perp market at once, so one market
    // answers for all of them.
    const [first] = await perpMarkets(ctx.exchange);
    if (first) {
      const link = await tradingKeyCheck(ctx, first);
      if (link.message) console.log(link.message);
      if (!link.ok && live) process.exit(1);
    }
  }

  while (!stopped()) {
    const markets = await watchList(ctx, me);
    if (markets.length === 0) {
      console.log("no open positions to guard");
      await sleep(POLL_MS, stopped);
      continue;
    }

    for (const market of markets) {
      if (!me) break;
      const snapshot = await marginSnapshot(ctx.exchange, market, me);
      const ratio = healthRatio(snapshot);
      const position = await positionIn(ctx.exchange, market);
      if (!position) continue;

      const notional = position.contracts * ((await liveMark(ctx.exchange, market)) ?? markOf(market.info));
      const label = Number.isFinite(ratio) ? `${ratio.toFixed(3)}x maintenance` : "no maintenance requirement";
      console.log(
        `${market.display}: ${position.side} ${position.contracts} (${notional.toFixed(2)} USDso) | health ${label} | ` +
          `status ${snapshot.status}`,
      );

      if (!Number.isFinite(ratio)) continue;

      if (ratio < FLATTEN_BELOW) {
        console.log(`health ${ratio.toFixed(3)} is below the flatten threshold, closing the position`);
        await closePosition(ctx, market, me, { label: "guard flatten" });
      } else if (ratio < REDUCE_BELOW) {
        console.log(`health ${ratio.toFixed(3)} is below the reduce threshold, closing ${REDUCE_PCT}%`);
        await closePosition(ctx, market, me, { fraction: REDUCE_PCT / 100, label: "guard reduce" });
      }
    }

    await sleep(POLL_MS, stopped);
  }

  console.log("guard stopped");
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
