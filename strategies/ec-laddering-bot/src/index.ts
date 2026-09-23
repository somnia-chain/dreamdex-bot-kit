/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-ec-kit/blob/main/LICENSE
 */

// ec-laddering-bot — a resting probability ladder on one event contract.
//
// Posts symmetric buy/sell rungs around the YES book mid (or a fixed center),
// refreshes each cycle, tracks net inventory, and flattens before expiry.
// Mean-reversion capture is passive-only: post-only limits, never cross.
//
//   npm start -w ec-laddering-bot

import {
  assertTxOk,
  placeLimit,
  cancelTracked,
  cancelVenueOrders,
  tryCancel,
  headroomSec,
  type Outcome,
  createExchange,
  envNum,
  maybeClaim,
  loadConfig,
  shutdown,
  activeMarkets,
  marketOnchain,
  isTradable,
  outcomeSymbols,
  seedInventory,
  snapshot,
  quantize,
  toRawUnits,
  toHuman,
  assertProbability,
  clampProbability,
  assertInventoryForSell,
  type EcContext,
  type UnifiedMarket,
  type MarketOnchain,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";

const REFRESH_MS = envNum("GRID_REFRESH_MS", 10_000);
const HEARTBEAT_MS = envNum("GRID_HEARTBEAT_MS", 30_000);
const LEVELS = envNum("GRID_LEVELS", 2);
const SPACING = Number(process.env.GRID_SPACING ?? 0.05);
const RUNG_SIZE = envNum("GRID_SIZE", 5);
const MAX_NET = envNum("GRID_MAX_INVENTORY", 20);
// Flatten this long before expiry. Scales with the series unless pinned: a flat
// 300s is right for the 15m and 1h windows but swallows a 5-minute one whole,
// and a venue running those exists today.
const FLATTEN_OVERRIDE_MS = process.env.GRID_FLATTEN_BUFFER_MS
  ? Number(process.env.GRID_FLATTEN_BUFFER_MS)
  : null;
const flattenBufferMs = (intervalSec: number | null | undefined): number =>
  FLATTEN_OVERRIDE_MS ?? headroomSec(intervalSec) * 1000;
const UNDERLYING = (process.env.EC_UNDERLYING ?? "").toUpperCase();
const WANT_MARKET = (process.env.EC_MARKET ?? "").trim();
const FIXED_CENTER = process.env.GRID_CENTER !== undefined && process.env.GRID_CENTER !== ""
  ? Number(process.env.GRID_CENTER)
  : null;

const sleep = async (ms: number, stopped?: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const seeded = new Set<string>();
let workingSymbol: string | null = null;
let flattenLogged = false;
let lastHeartbeat = 0;

interface Balances {
  yes: number;
  no: number;
  net: number;
}

async function readBalances(ctx: EcContext, onchain: MarketOnchain): Promise<Balances> {
  const addr = ctx.exchange.walletAddress;
  if (!addr) return { yes: 0, no: 0, net: 0 };
  const dp = onchain.decimals;
  const yesRaw = await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: addr, id: onchain.yesId });
  const noRaw = await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: addr, id: onchain.noId });
  const yes = toHuman(yesRaw, dp);
  const no = toHuman(noRaw, dp);
  return { yes, no, net: yes - no };
}

async function cancelOpenOn(ctx: EcContext, symbol: string): Promise<number> {
  if (ctx.config.dryRun) return 0;
  const open = await ctx.exchange.fetchOpenOrders(symbol);
  let canceled = 0;
  for (const o of open) if ((await tryCancel(ctx, o.id, symbol)) === "cancelled") canceled++;
  return canceled;
}

/** One live market with the most time left (for grid or flatten). */
async function pickMarket(
  ctx: EcContext,
): Promise<{ market: UnifiedMarket; onchain: MarketOnchain; ttlMs: number } | null> {
  const nowMs = Date.now();
  let best: { market: UnifiedMarket; onchain: MarketOnchain; ttlMs: number } | null = null;

  for (const m of await activeMarkets(ctx, { max: 50 })) {
    if (WANT_MARKET && m.symbol !== WANT_MARKET) continue;
    if (UNDERLYING && !m.symbol.toUpperCase().includes(UNDERLYING)) continue;

    const onchain = await marketOnchain(ctx, m);
    if (!onchain || !isTradable(onchain)) continue;

    // On-chain expiry is unix seconds (same as ec-passive).
    const expirySec = Number(onchain.expiry);
    const expiryMs = expirySec * 1000;
    if (!Number.isFinite(expirySec) || expirySec <= 0 || expiryMs <= nowMs) continue;
    const ttlMs = expiryMs - nowMs;

    if (!best || ttlMs > best.ttlMs) best = { market: m, onchain, ttlMs };
  }
  return best;
}

/** Actionable hint when pickMarket finds nothing (indexer empty, venue scope, or filters). */
async function explainNoMarket(ctx: EcContext): Promise<string> {
  const { network, venueId, operatorId } = ctx.config;
  let scoped: UnifiedMarket[];
  try {
    scoped = await activeMarkets(ctx, { max: 50 });
  } catch (e) {
    return (e as Error).message;
  }

  if (scoped.length === 0) {
    const all = Object.values(await ctx.exchange.loadMarkets(true));
    const binaryTotal = all.filter((m) => m.type === "binary").length;
    const binaryActive = all.filter((m) => m.type === "binary" && m.active).length;
    if (binaryActive === 0) {
      return (
        `indexer shows 0 active binary markets on ${network} (${binaryTotal} binary rows loaded). ` +
        `Check NETWORK=testnet|mainnet in .env and set VENUE_ID from a live market row (see docs/event-contracts.md).`
      );
    }
    return (
      `${binaryActive} indexer-active binary market(s) but activeMarkets returned none after venue scope ` +
        `(venueId=${venueId ?? "unset"} operatorId=${operatorId ?? "unset"}) — set VENUE_ID or OPERATOR_ID like other EC bots.`
    );
  }

  let trading = 0;
  let expired = 0;
  for (const m of scoped) {
    if (WANT_MARKET && m.symbol !== WANT_MARKET) continue;
    if (UNDERLYING && !m.symbol.toUpperCase().includes(UNDERLYING)) continue;
    const onchain = await marketOnchain(ctx, m);
    if (!onchain || !isTradable(onchain)) continue;
    trading++;
    const expiryMs = Number(onchain.expiry) * 1000;
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) expired++;
  }

  const filt = `${UNDERLYING ? ` EC_UNDERLYING=${UNDERLYING}` : ""}${WANT_MARKET ? ` EC_MARKET=${WANT_MARKET}` : ""}`.trim();
  if (trading === 0) {
    return `${scoped.length} scoped market(s) but none Trading on-chain${filt ? ` with${filt}` : ""}.`;
  }
  if (expired === trading) {
    return `${trading} Trading market(s) but all past expiry — wait for the next window roll.`;
  }
  return `${scoped.length} scoped, ${trading} Trading — no pick (unexpected; check filters).`;
}

interface Rung {
  side: "buy" | "sell";
  price: number;
}

function buildRungs(center: number, size: number): Rung[] {
  const rungs: Rung[] = [];
  for (let i = 1; i <= LEVELS; i++) {
    rungs.push({ side: "buy", price: center - i * SPACING });
    rungs.push({ side: "sell", price: center + i * SPACING });
  }
  return rungs;
}

function filterRungs(rungs: Rung[], bal: Balances, size: number): Rung[] {
  return rungs.filter((r) => {
    if (r.side === "buy" && bal.net >= MAX_NET) return false;
    if (r.side === "sell" && bal.net <= -MAX_NET) return false;
    if (r.side === "sell" && bal.yes < size - 1e-9) return false;
    return true;
  });
}

async function iocSell(
  ctx: EcContext,
  market: UnifiedMarket,
  onchain: MarketOnchain,
  outcome: Outcome,
  amount: number,
  book: { bids: [number, number][] },
): Promise<number> {
  const bestBid = book.bids[0]?.[0];
  if (bestBid === undefined || amount <= 0) return 0;
  const price = clampProbability(bestBid - 0.002);
  assertProbability(price);
  const order = await placeLimit(ctx, {
    market, onchain, outcome, side: "sell", price, size: amount, type: "ioc",
  });
  return order.filled;
}

async function flatten(
  ctx: EcContext,
  market: UnifiedMarket,
  onchain: MarketOnchain,
  yes: string,
  no: string,
  ttlMs: number,
): Promise<void> {
  if (!flattenLogged) {
    flattenLogged = true;
    log(`flatten window (${Math.round(ttlMs / 1000)}s to expiry) — cancel, burn paired sets, IOC excess`);
  }

  const canceled = await cancelOpenOn(ctx, yes);
  if (canceled > 0) log(`flatten: canceled ${canceled} resting order(s) on ${yes}`);

  if (ctx.config.dryRun || !ctx.exchange.walletAddress) {
    const bal = await readBalances(ctx, onchain);
    log(`DRY flatten ${market.symbol}: net ${bal.net.toFixed(2)} (YES ${bal.yes.toFixed(2)} / NO ${bal.no.toFixed(2)})`);
    return;
  }

  let bal = await readBalances(ctx, onchain);
  const paired = quantize(ctx, Math.min(bal.yes, bal.no));
  if (paired > 0) {
    assertTxOk(await ctx.exchange.burnSet(market.symbol, paired), `burnSet(${market.symbol})`);
    await sleep(2_000);
    bal = await readBalances(ctx, onchain);
    log(`flatten: burned ${paired} complete set(s); net now ${bal.net.toFixed(2)}`);
  }

  const addr = ctx.exchange.walletAddress!;
  const dp = onchain.decimals;

  if (bal.yes > bal.no + 1e-9) {
    const excess = quantize(ctx, bal.yes - bal.no);
    if (excess > 0) {
      const raw = toRawUnits(excess, dp);
      assertInventoryForSell("sell", await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: addr, id: onchain.yesId }), raw, "YES");
      const book = await ctx.exchange.fetchOrderBook(yes, 3);
      const filled = await iocSell(ctx, market, onchain, "YES", excess, book);
      log(`flatten: IOC sold ${filled}/${excess} YES excess`);
    }
  } else if (bal.no > bal.yes + 1e-9) {
    const excess = quantize(ctx, bal.no - bal.yes);
    if (excess > 0) {
      const raw = toRawUnits(excess, dp);
      assertInventoryForSell("sell", await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: addr, id: onchain.noId }), raw, "NO");
      const book = await ctx.exchange.fetchOrderBook(no, 3);
      const filled = await iocSell(ctx, market, onchain, "NO", excess, book);
      log(`flatten: IOC sold ${filled}/${excess} NO excess`);
    }
  }

  bal = await readBalances(ctx, onchain);
  if (Math.abs(bal.net) > RUNG_SIZE) {
    log(`flatten: residual net ${bal.net.toFixed(2)} — book may be one-sided; hold or redeem after settle via ec-settlement`);
  }
}

async function cycleGrid(
  ctx: EcContext,
  market: UnifiedMarket,
  onchain: MarketOnchain,
  yes: string,
  ttlMs: number,
): Promise<void> {
  if (!seeded.has(market.symbol)) {
    if (!ctx.config.dryRun) await seedInventory(ctx, market, onchain);
    seeded.add(market.symbol);
  }

  const snap = await snapshot(ctx, yes, 5);
  const center =
    FIXED_CENTER !== null && Number.isFinite(FIXED_CENTER)
      ? FIXED_CENTER
      : snap.yesMid !== undefined && snap.yesMid > 0 && snap.yesMid < 1
        ? snap.yesMid
        : 0.5;

  const size = quantize(ctx, RUNG_SIZE);
  if (size <= 0) {
    log(`${yes}: GRID_SIZE ${RUNG_SIZE} below one lot — skipping`);
    return;
  }

  const bal = await readBalances(ctx, onchain);
  const rungs = filterRungs(buildRungs(center, size), bal, size);

  const canceled = await cancelOpenOn(ctx, yes);
  if (canceled > 0) log(`${yes}: refreshed ladder (canceled ${canceled} stale order(s))`);

  const bidParts: string[] = [];
  const askParts: string[] = [];

  for (const r of rungs) {
    const px = clampProbability(r.price);
    assertProbability(px);

    if (ctx.config.dryRun) {
      (r.side === "buy" ? bidParts : askParts).push(`${size}@${px.toFixed(3)}`);
      continue;
    }

    if (r.side === "sell") {
      const raw = toRawUnits(size, onchain.decimals);
      const held = await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.exchange.walletAddress!, id: onchain.yesId, });
      assertInventoryForSell("sell", held, raw, "YES");
    }

    // placeLimit snaps to the tick grid as integers and checks the receipt: a
    // float price reverts outright on an 18-decimal venue, and a reverted rung
    // otherwise looks identical to one that simply did not rest.
    const order = await placeLimit(ctx, {
      market, onchain, outcome: "YES", side: r.side, price: px, size, type: "post-only",
    });
    if (order.rested) {
      (r.side === "buy" ? bidParts : askParts).push(`${order.size}@${order.price.toFixed(3)}`);
    }
  }

  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    log(
      `heartbeat · ${market.symbol} · center ${center.toFixed(3)}${FIXED_CENTER !== null ? " (fixed)" : " (mid)"} · ` +
        `net ${bal.net.toFixed(2)} · bids [${bidParts.join(", ") || "-"}] · asks [${askParts.join(", ") || "-"}] · ` +
        `${Math.round(ttlMs / 60_000)}m left`,
    );
  } else if (bidParts.length + askParts.length > 0) {
    log(
      `ladder ${yes} · center ${center.toFixed(3)} · net ${bal.net.toFixed(2)} · ` +
        `bids [${bidParts.join(", ")}] · asks [${askParts.join(", ")}]`,
    );
  }
}

async function main() {
  if (LEVELS < 1) throw new Error("GRID_LEVELS must be >= 1");
  if (!(SPACING > 0 && SPACING < 1)) throw new Error("GRID_SPACING must be in (0, 1)");
  if (FIXED_CENTER !== null && !(FIXED_CENTER > 0 && FIXED_CENTER < 1)) {
    throw new Error("GRID_CENTER must be a probability in (0, 1)");
  }

  const ctx = createExchange({ withSigner: !loadConfig().dryRun });
  log(
    `ec-laddering-bot up as ${ctx.exchange.walletAddress ?? "(no key, dry run)"} · dryRun=${ctx.config.dryRun} · ` +
      `network=${ctx.config.network} · levels=${LEVELS} spacing=${SPACING} size=${RUNG_SIZE} maxNet=${MAX_NET} flatten=${FLATTEN_OVERRIDE_MS ? FLATTEN_OVERRIDE_MS / 1000 + "s" : "40% of window"}`,
  );

  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  let lastEmptyHint = 0;

  while (!stop) {
    try {
      // Collect anything that settled since the last pass. Self-throttled
      // (AUTO_CLAIM_INTERVAL_MS) and a no-op under AUTO_CLAIM=false.
      await maybeClaim(ctx);
      const picked = await pickMarket(ctx);
      if (!picked) {
        const now = Date.now();
        if (now - lastEmptyHint >= HEARTBEAT_MS) {
          lastEmptyHint = now;
          log(`no market to ladder — ${await explainNoMarket(ctx)}`);
        }
        await sleep(REFRESH_MS, () => stop);
        continue;
      }

      const { market, onchain, ttlMs } = picked;
      const { yes, no } = outcomeSymbols(market);

      if (market.symbol !== workingSymbol) {
        if (workingSymbol) {
          log(`following window: ${workingSymbol} → ${market.symbol}`);
          seeded.delete(workingSymbol);
        }
        workingSymbol = market.symbol;
        flattenLogged = false;
      }

      if (ttlMs < flattenBufferMs(isBinaryMarket(market.info) ? Number(market.info.intervalSec) : null)) {
        await flatten(ctx, market, onchain, yes, no, ttlMs);
      } else {
        await cycleGrid(ctx, market, onchain, yes, ttlMs);
      }
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;
    await sleep(REFRESH_MS, () => stop);
  }

  if (!ctx.config.dryRun) {
    try {
      // Our own record first — the indexer lags, so a rung posted seconds ago is
      // invisible to the sweep below and would be left resting.
      const { cancelled } = await cancelTracked(ctx);
      const swept = await cancelVenueOrders(ctx);
      log(`canceled ${cancelled} tracked + ${swept} swept on shutdown`);
    } catch (e) {
      log(`shutdown cancel failed: ${(e as Error).message}`);
    }
  }
  await shutdown(ctx);
  log("ec-laddering-bot stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
