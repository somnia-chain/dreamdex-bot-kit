/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// ec-passive — patient execution with a resting limit order.
//
// The bot wants to own the Up (or Down) side of the current window, but only
// at its price: it rests a POST-ONLY bid at EC_TARGET and walks away. Dips
// fill it; anything else leaves it untouched. It never crosses the spread —
// if the book is already at or below the target, it does nothing and waits.
// That asymmetry is the lesson: a passive order buys cheaper than a market
// order, and the cost is that it might not buy at all.
//
// What the loop does each cycle:
//   • Picks ONE market: Trading on-chain, EC_UNDERLYING match, and enough time
//     left for a dip to happen (EC_MIN_LEFT_S). Prefers the longest window.
//   • Reads fills from its own trade history — the position is whatever
//     actually filled, not whatever was ordered.
//   • Keeps exactly one resting bid alive at the target until EC_MAX_POSITION
//     shares are owned, then cancels it and just holds.
//
// Lifecycle notes baked in (see docs/event-contracts.md):
//   • Orders are capped at the market's own expiry, so a crashed bot's bid
//     ages off the book with the window — nothing rests forever.
//   • When the window rolls, the bot follows the successor market and starts
//     a fresh position count there.
//
// DRY_RUN=true (default) logs intent. Set DRY_RUN=false + a funded
// PRIVATE_KEY to rest a real bid.
//
//   npm start -w ec-passive

import {
  createExchange,
  envNum,
  maybeClaim,
  loadConfig,
  shutdown,
  activeMarkets,
  marketOnchain,
  isTradable,
  outcomeSymbols,
  quantize,
  assertProbability,
  placeLimit,
  cancelTracked,
  tryCancel,
  type EcContext,
  type UnifiedMarket,
  type MarketOnchain,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";

const SIDE = (process.env.EC_SIDE ?? "up").toLowerCase(); // "up" | "down"
const TARGET = Number(process.env.EC_TARGET ?? 0.4); // max probability to pay for that side
const SIZE = envNum("EC_SIZE", 5); // shares per resting order
const MAX_POSITION = envNum("EC_MAX_POSITION", 20); // stop accumulating here (per window)
const UNDERLYING = (process.env.EC_UNDERLYING ?? "").toUpperCase(); // "" = any, or e.g. "BTC"
const REFRESH_MS = envNum("EC_REFRESH_MS", 15_000);
// A passive bid needs time for a dip to reach it, so skip windows already
// closing. Scale it to the series rather than fixing it: a flat 10 minutes is
// sensible against 1h windows but rejects every market on a venue running 5m
// or 10m series (testnet does exactly that today), and the bot then waits
// forever instead of resting a bid. 40% of the window, 30s floor, 600s cap.
// EC_MIN_LEFT_S pins a fixed number of seconds when you want one.
const MIN_LEFT_OVERRIDE_S = process.env.EC_MIN_LEFT_S ? Number(process.env.EC_MIN_LEFT_S) : null;
const minLeftFor = (intervalSec: number | null): number =>
  MIN_LEFT_OVERRIDE_S ??
  (intervalSec && intervalSec > 0 ? Math.max(30, Math.min(600, intervalSec * 0.4)) : 600);

const sleep = async (ms: number, stopped?: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const startedAt = Date.now();

/** Sum of this wallet's buys on `symbol` since the bot started: shares + average cost. */
async function filledPosition(ctx: EcContext, symbol: string): Promise<{ shares: number; avg: number }> {
  const trades = await ctx.exchange.fetchMyTrades(symbol, startedAt);
  let shares = 0;
  let cost = 0;
  for (const t of trades) {
    // This bot only ever bids, so any non-sell trade on the symbol is ours —
    // some fill kinds (mint-a-pair) may not carry an explicit side.
    if (t.side === "sell") continue;
    shares += t.amount;
    cost += t.amount * t.price;
  }
  return { shares, avg: shares > 0 ? cost / shares : 0 };
}

/** The market to work: Trading on-chain, underlying match, most time left. */
async function pickMarket(
  ctx: EcContext,
): Promise<{ market: UnifiedMarket; onchain: MarketOnchain; left: number } | null> {
  const now = Date.now() / 1000;
  let best: { market: UnifiedMarket; onchain: MarketOnchain; left: number } | null = null;
  for (const m of await activeMarkets(ctx)) {
    if (UNDERLYING && !m.symbol.toUpperCase().includes(UNDERLYING)) continue;
    const onchain = await marketOnchain(ctx, m);
    if (!onchain || !isTradable(onchain)) continue;
    const left = Number(onchain.expiry) - now;
    const interval = isBinaryMarket(m.info) ? Number(m.info.intervalSec ?? 0) : 0;
    if (left < minLeftFor(interval || null)) continue;
    if (!best || left > best.left) best = { market: m, onchain, left };
  }
  return best;
}

async function main() {
  if (SIDE !== "up" && SIDE !== "down") throw new Error(`EC_SIDE must be "up" or "down", got "${SIDE}"`);
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });
  log(
    `ec-passive up as ${ctx.exchange.walletAddress ?? "(no key, dry run)"} · dryRun=${ctx.config.dryRun}` +
      ` · side=${SIDE} target=${TARGET} size=${SIZE} max=${MAX_POSITION}${UNDERLYING ? ` underlying=${UNDERLYING}` : ""}`,
  );

  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  let workingSymbol: string | null = null; // the outcome symbol we're accumulating
  let lastShares = 0;
  let holding = false; // logged the "position complete" state for this window

  while (!stop) {
    try {
      // Collect anything that settled since the last pass. Self-throttled
      // (AUTO_CLAIM_INTERVAL_MS) and a no-op under AUTO_CLAIM=false.
      await maybeClaim(ctx);
      const picked = await pickMarket(ctx);
      if (!picked) {
        log(`no Trading market with enough headroom${UNDERLYING ? ` for ${UNDERLYING}` : ""} — waiting`);
        await sleep(REFRESH_MS, () => stop);
        continue;
      }
      const syms = outcomeSymbols(picked.market);
      const symbol = SIDE === "up" ? syms.yes : syms.no;

      // Window rolled → the old bid died with its market; start fresh here.
      if (symbol !== workingSymbol) {
        if (workingSymbol) log(`window rolled: ${workingSymbol} → ${symbol}`);
        workingSymbol = symbol;
        lastShares = 0;
        holding = false;
      }

      // Fill + open-order reads need a wallet address; a keyless dry run
      // still shows the placement decisions, just without position state.
      const hasWallet = Boolean(ctx.exchange.walletAddress);
      const { shares, avg } = hasWallet ? await filledPosition(ctx, symbol) : { shares: 0, avg: 0 };
      if (shares > lastShares) {
        log(`FILLED +${(shares - lastShares).toFixed(2)} → ${shares.toFixed(2)} shares @ avg ${avg.toFixed(3)}`);
        lastShares = shares;
      }

      const open = hasWallet ? await ctx.exchange.fetchOpenOrders(symbol) : [];

      if (shares >= MAX_POSITION) {
        // Done for this window: pull any remaining bid and hold what filled.
        for (const o of open) {
          if (ctx.config.dryRun || (await tryCancel(ctx, o.id, symbol)) === "cancelled") {
            log(`canceled resting bid ${o.id} @ ${o.price}`);
          }
        }
        if (!holding) {
          holding = true;
          log(`position complete: ${shares.toFixed(2)} ≥ ${MAX_POSITION} @ avg ${avg.toFixed(3)} — holding until the window resolves`);
        }
        await sleep(REFRESH_MS, () => stop);
        continue;
      }

      // The price is in the OUTCOME's own probability (a Down price is the
      // Down probability — the SDK handles the Up-terms complement).
      const px = Number(ctx.exchange.priceToPrecision(symbol, TARGET));
      assertProbability(px);
      const size = quantize(ctx, Math.min(SIZE, MAX_POSITION - shares));
      if (size <= 0) {
        await sleep(REFRESH_MS, () => stop);
        continue;
      }

      // Never take: if the market is already at/below the target, a post-only
      // bid would cross and be rejected. Do nothing — patience is the strategy.
      // (An impatient variant would IOC here; that's a different bot.)
      const book = await ctx.exchange.fetchOrderBook(symbol, 1);
      const bestAsk = book.asks[0]?.[0];
      if (bestAsk !== undefined && bestAsk <= px) {
        log(`${symbol}: ask ${bestAsk.toFixed(3)} ≤ target ${px.toFixed(3)} — market came past us, staying passive`);
        await sleep(REFRESH_MS, () => stop);
        continue;
      }

      // Keep exactly one resting bid at the target. An order already at the
      // right price stays put — churning cancel/replace just loses queue spot.
      const resting = open.find((o) => o.side === "buy" && o.price !== undefined && Math.abs(o.price - px) < 1e-9);
      for (const o of open) {
        if (o === resting) continue;
        if (ctx.config.dryRun || (await tryCancel(ctx, o.id, symbol)) === "cancelled") {
          log(`canceled stray order ${o.id} @ ${o.price}`);
        }
      }
      if (!resting) {
        if (ctx.config.dryRun) {
          log(`DRY rest ${symbol}: buy ${size}@${px.toFixed(3)} (ask ${bestAsk?.toFixed(3) ?? "-"}, ${Math.round(picked.left / 60)}min left)`);
        } else {
          const order = await placeLimit(ctx, {
            market: picked.market,
            onchain: picked.onchain,
            outcome: SIDE === "up" ? "YES" : "NO",
            side: "buy",
            price: px,
            size,
            type: "post-only",
            expiresInSec: Math.max(60, Math.round(REFRESH_MS / 1000) * 3),
          });
          if (order.rested) {
            log(`rested ${symbol}: buy ${order.size}@${order.price.toFixed(3)} (ask ${bestAsk?.toFixed(3) ?? "-"}, ${Math.round(picked.left / 60)}min left)`);
          } else {
            // A rejected post-only is not a revert (placeLimit would have thrown):
            // the book simply moved into us and the order rested nothing.
            log(`post-only bid did not rest — the book moved into us; retrying next cycle`);
          }
        }
      }
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    await sleep(REFRESH_MS, () => stop);
  }

  // Pull the resting bid on the way out; report what actually filled.
  if (!ctx.config.dryRun && workingSymbol) {
    try {
      // Our own record first — the indexer lags, so the bid posted seconds ago is
      // invisible to the sweep below and would be left resting.
      const { cancelled } = await cancelTracked(ctx);
      const open = await ctx.exchange.fetchOpenOrders(workingSymbol);
      let swept = 0;
      for (const o of open) if ((await tryCancel(ctx, o.id, workingSymbol)) === "cancelled") swept++;
      const { shares, avg } = await filledPosition(ctx, workingSymbol);
      log(`stopped: canceled ${cancelled} tracked + ${swept} swept; holding ${shares.toFixed(2)} shares @ avg ${avg.toFixed(3)}`);
    } catch (e) {
      log(`shutdown cancel failed: ${(e as Error).message}`);
    }
  }
  await shutdown(ctx);
  log("ec-passive stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
