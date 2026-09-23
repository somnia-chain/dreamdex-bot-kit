/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// maker-bot — a two-sided POST-ONLY market maker for DreamDEX event contracts.
// For each active market it quotes a symmetric bid + ask around a fair YES
// probability, refreshing every cycle (cancel stale → re-quote). This is the
// piece the in-repo examples lack: a resting-liquidity provider, not a taker.
//
// How it stays safe:
//   • POST-ONLY (timeInForce "PO") — a quote that would cross the book is
//     rejected instead of taking, so the maker never pays the spread.
//   • Gates on the AUTHORITATIVE on-chain status (never the lagging indexer).
//   • Mints a YES/NO set once (mint-a-pair) so the SELL-YES side is
//     collateralised — you can't sell an outcome you don't hold.
//   • Cancels its own resting orders before re-quoting, so it never stacks
//     duplicate levels or self-matches (the venue blocks self-matches anyway).
//
// Fair value here is deliberately simple — the mid of the current YES book, or
// 0.5 when a side is empty. Swap in your own signal (an external price, a model)
// to actually make money; the plumbing around it is the point.
//
// DRY_RUN=true (default) logs the quotes it would place. Set DRY_RUN=false + a
// funded PRIVATE_KEY to quote for real.
//
//   npm start -w ec-maker

import {
  createExchange,
  envNum,
  maybeClaim,
  loadConfig,
  shutdown,
  activeMarkets,
  explainEmptyScope,
  marketOnchain,
  isTradable,
  minLeftSec,
  netPosition,
  outcomeSymbols,
  seedInventory,
  quantize,
  assertProbability,
  clampProbability,
  placeLimit,
  cancelTracked,
  cancelVenueOrders,
  tryCancel,
  sellableSize,
  type EcContext,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";

const REFRESH_MS = envNum("MM_REFRESH_MS", 10_000);
const HALF_SPREAD = Number(process.env.MM_SPREAD ?? 0.02); // half-spread in probability
const QUOTE_SIZE = envNum("MM_QUOTE_SIZE", 5); // shares per side
// A two-sided quote is not automatically flat: fills arrive unevenly. Past this
// NET inventory the maker keeps quoting only the side that brings it back.
const MAX_NET = envNum("MM_MAX_INVENTORY", 20);
// Interruptible sleep: wake within ~500ms of a stop signal instead of finishing
// the full interval. Without this a SIGTERM lands mid-sleep and the shutdown
// cancel pass can start up to REFRESH_MS later — long enough for a supervisor's
// kill grace to expire with quotes still resting on the book.
const sleep = async (ms: number, stopped?: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const seeded = new Set<string>();

/** Fair YES probability: mid of the book, else 0.5. Replace with your signal. */
function fairYes(bids: [number, number][], asks: [number, number][]): number {
  const bid = bids[0]?.[0];
  const ask = asks[0]?.[0];
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return bid ?? ask ?? 0.5;
}

// Trade one underlying only, or leave it blank for whatever the venue runs.
// ec-passive and ec-laddering-bot have always honoured this; these two did not,
// so a config that said BTC quietly traded ETH as well.
const UNDERLYING = (process.env.EC_UNDERLYING ?? "").toUpperCase();

async function quoteOne(ctx: EcContext, market: UnifiedMarket): Promise<void> {
  if (UNDERLYING && !market.symbol.toUpperCase().includes(UNDERLYING)) return;
  const onchain = await marketOnchain(ctx, market);
  if (!onchain) return;
  if (!isTradable(onchain)) {
    seeded.delete(market.symbol);
    return;
  }

  // Do not act on a window about to close. The other three strategies gate on
  // this; these two did not, and both of today's on-chain reverts landed on the
  // expiry second of the market they were sent to. Scaled to the cadence, so a
  // 60s series is not rejected outright.
  const interval = isBinaryMarket(market.info) ? Number(market.info.intervalSec ?? 0) : 0;
  if (Number(onchain.expiry) - Date.now() / 1000 < minLeftSec(interval || null)) return;

  if (!seeded.has(market.symbol)) {
    if (!ctx.config.dryRun) await seedInventory(ctx, market, onchain);
    seeded.add(market.symbol);
  }

  const { yes } = outcomeSymbols(market);
  const ob = await ctx.exchange.fetchOrderBook(yes, 3);
  const fair = fairYes(ob.bids, ob.asks);

  const size = quantize(ctx, QUOTE_SIZE); // venue lot grid
  if (size <= 0) {
    log(`${yes}: MM_QUOTE_SIZE ${QUOTE_SIZE} is below one lot — skipping`);
    return;
  }
  const bidPx = clampProbability(fair - HALF_SPREAD);
  const askPx = clampProbability(fair + HALF_SPREAD);
  assertProbability(bidPx);
  assertProbability(askPx);

  // Cancel our stale quotes on this market before re-posting.
  if (!ctx.config.dryRun) {
    const open = await ctx.exchange.fetchOpenOrders(yes);
    // One failed cancel must not skip the rest; tryCancel also drops a pulled or
    // already-filled order from the shutdown list.
    for (const o of open) await tryCancel(ctx, o.id, yes);
  }

  // Past the cap, quote only the side that unwinds. Fills arrive unevenly, so a
  // two-sided quote does not keep a maker flat on its own. Computed before the
  // dry-run branch: a dry run that advertises a quote the live path would skip
  // is worse than no dry run.
  const net = await netPosition(ctx, onchain);
  const skipBid = net >= MAX_NET;
  const skipAsk = net <= -MAX_NET;
  const capNote = (skip: boolean) => (skip ? `none (net ${net.toFixed(2)} at cap)` : null);

  if (ctx.config.dryRun) {
    log(
      `DRY quote ${yes}: bid ${capNote(skipBid) ?? `${size}@${bidPx.toFixed(3)}`}` +
        ` / ask ${capNote(skipAsk) ?? `${size}@${askPx.toFixed(3)}`} (fair ${fair.toFixed(3)})`,
    );
    return;
  }

  // Post-only: rejected if it would cross, so the maker only ever rests liquidity.
  // placeLimit snaps both sides to the tick grid as integers — handing the SDK a
  // float price reverts outright on an 18-decimal venue.
  if (!skipBid) {
    await placeLimit(ctx, { market, onchain, outcome: "YES", side: "buy", price: bidPx, size, type: "post-only" });
  }
  // The ask is capped by inventory: selling needs the tokens, and the seeded
  // amount (MM_INVENTORY) is independent of MM_QUOTE_SIZE. A short ask is
  // better than a failed one, and 0 means quote the bid alone this cycle.
  const askSize = skipAsk ? 0 : await sellableSize(ctx, onchain, "YES", size);
  if (askSize > 0) {
    await placeLimit(ctx, { market, onchain, outcome: "YES", side: "sell", price: askPx, size: askSize, type: "post-only" });
  }
  const bidLeg = capNote(skipBid) ?? `${size}@${bidPx.toFixed(3)}`;
  const askLeg = askSize > 0 ? `${askSize}@${askPx.toFixed(3)}` : (capNote(skipAsk) ?? `none (no inventory)`);
  log(`quote ${yes}: bid ${bidLeg} / ask ${askLeg} (fair ${fair.toFixed(3)})`);
}

// Explaining an empty venue every cycle would drown the log; once a minute is
// enough to be noticed and not enough to be noise.
const EMPTY_HINT_MS = 60_000;
let lastEmptyAt = 0;

async function main() {
  // A signer is only needed to actually send orders. In DRY_RUN you can watch
  // the bot reason about live books with no key at all.
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });
  log(`maker-bot up as ${ctx.exchange.walletAddress ?? "(no key, dry run)"} · dryRun=${ctx.config.dryRun} · spread=±${HALF_SPREAD} size=${QUOTE_SIZE}`);

  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  while (!stop) {
    try {
      // Collect anything that settled since the last pass. Self-throttled
      // (AUTO_CLAIM_INTERVAL_MS) and a no-op under AUTO_CLAIM=false.
      await maybeClaim(ctx);
      const markets = await activeMarkets(ctx);
      if (markets.length === 0) {
        const now = Date.now();
        if (now - lastEmptyAt >= EMPTY_HINT_MS) {
          lastEmptyAt = now;
          log(`no market to quote — ${await explainEmptyScope(ctx)}`);
        }
      }
      for (const m of markets) {
        if (stop) break;
        try {
          await quoteOne(ctx, m);
        } catch (e) {
          log(`${m.symbol} error: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;
    await sleep(REFRESH_MS, () => stop);
  }

  // Best-effort: pull our quotes on the way out so we don't leave stale liquidity.
  if (!ctx.config.dryRun) {
    try {
      // Our own record first: the indexer lags, so the quote posted seconds ago
      // is invisible to it and would be left resting (measured: 14 cancelled,
      // 1 stranded). The sweep afterwards catches anything from an earlier run.
      const { cancelled, tracked } = await cancelTracked(ctx);
      const swept = await cancelVenueOrders(ctx);
      log(`canceled ${cancelled} of ${tracked} tracked + ${swept} swept on shutdown`);
    } catch (e) {
      log(`shutdown cancel failed: ${(e as Error).message}`);
    }
  }
  await shutdown(ctx);
  log("maker-bot stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
