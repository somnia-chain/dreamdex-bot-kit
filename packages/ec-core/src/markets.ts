/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// DreamDEX-venue helpers over the unified exchange: list the venue's active
// event-contract markets, resolve a market's authoritative on-chain snapshot,
// and gate on live status. Event contracts are binary (YES/NO); the exchange
// derives `active` from the trading window, not the lagging indexed status.

import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";
import type { Hex } from "viem";
import type { EcContext } from "./exchange.js";
import type { EcConfig } from "./config.js";

/** On-chain MarketStatus enum: 0 Listed · 1 Trading · 2 Locked · 3 Settling · 4 Resolved · 5 Voided. */
export const MARKET_STATUS = {
  Listed: 0,
  Trading: 1,
  Locked: 2,
  Settling: 3,
  Resolved: 4,
  Voided: 5,
} as const;

/** The venue a set of markets belongs to. `venueId` is the on-chain bytes32 venue
 *  id (the `venueIdHash` in venues.json), which is what indexed rows carry. */
export interface VenueScope {
  venueId?: string;
  operatorId?: number;
}

const sameVenue = (a?: string | null, b?: string | null) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** The on-chain venue id on a market row (binary markets only). */
export const venueOf = (m: UnifiedMarket): string | null =>
  m.info.marketType === "BINARY" ? (m.info.venueId ?? null) : null;
/** The operator id on a market row (binary markets only). */
export const operatorOf = (m: UnifiedMarket): number | null =>
  m.info.marketType === "BINARY" ? (m.info.operatorId ?? null) : null;

/** True if a binary market falls inside `scope`. An empty scope matches everything. */
export function inVenue(scope: VenueScope, market: UnifiedMarket): boolean {
  if (market.info.marketType !== "BINARY") return false;
  const info = market.info;
  if (scope.venueId) return sameVenue(info.venueId, scope.venueId);
  if (scope.operatorId !== undefined) return info.operatorId === scope.operatorId;
  return true;
}

/**
 * Reload the registry and return the DreamDEX venue's ACTIVE binary markets.
 *
 * Scoping ("via DreamDEX") resolves in this order:
 *   1. `VENUE_ID` (bytes32) or `OPERATOR_ID` from .env — explicit wins.
 *   2. Otherwise inferred from the live markets themselves: if every currently
 *      active market sits on ONE venue, that's the venue.
 *
 * Do NOT infer the venue from the deployment manifest: on both networks the
 * manifest's "active" venue disagrees with where the live markets actually are.
 * If live markets span several venues we throw rather than silently trade a
 * venue you didn't mean.
 *
 * Pass `opts.scope` to override the .env-derived scope, e.g. to keep using the
 * venue `resolveVenue` inferred for the rest of a run.
 */
export async function activeMarkets(
  ctx: EcContext,
  opts: { asset?: string; max?: number; scope?: VenueScope } = {},
): Promise<UnifiedMarket[]> {
  const { config } = ctx;
  const all = Object.values(await ctx.exchange.loadMarkets(true));
  let live = all.filter((m) => m.type === "binary" && m.active);

  const scope: VenueScope =
    opts.scope ??
    (config.venueId
      ? { venueId: config.venueId }
      : config.operatorId !== undefined
        ? { operatorId: config.operatorId }
        : {});

  if (scope.venueId || scope.operatorId !== undefined) {
    live = live.filter((m) => inVenue(scope, m));
  } else {
    const venues = [...new Set(live.map((m) => String(venueOf(m) ?? "").toLowerCase()))];
    if (venues.length > 1) {
      const detail = venues
        .map((v) => {
          const m = live.find((x) => sameVenue(venueOf(x), v));
          return `${v} (operatorId ${m ? operatorOf(m) : "?"})`;
        })
        .join(", ");
      throw new Error(
        `Live markets span ${venues.length} venues: ${detail}. Set VENUE_ID (or OPERATOR_ID) ` +
          `in .env to scope to the DreamDEX venue.`,
      );
    }
  }

  return live
    .filter((m) => (opts.asset ? m.info.marketType === "BINARY" && m.info.asset === opts.asset : true))
    .slice(0, opts.max ?? config.maxMarkets);
}

/** The venue the currently-live markets sit on, plus how it was chosen. Used by
 *  the doctor so you can see exactly which venue a bot would trade. */
export async function resolveVenue(
  ctx: EcContext,
): Promise<{ scope: VenueScope; source: "env" | "inferred" | "none"; markets: number }> {
  const { config } = ctx;
  if (config.venueId) return { scope: { venueId: config.venueId }, source: "env", markets: (await activeMarkets(ctx, { max: 1e6 })).length };
  if (config.operatorId !== undefined)
    return { scope: { operatorId: config.operatorId }, source: "env", markets: (await activeMarkets(ctx, { max: 1e6 })).length };
  const live = (Object.values(await ctx.exchange.loadMarkets(true)) as UnifiedMarket[]).filter(
    (m) => m.type === "binary" && m.active,
  );
  const first = live[0];
  if (!first) return { scope: {}, source: "none", markets: 0 };
  return {
    scope: { venueId: venueOf(first) ?? undefined, operatorId: operatorOf(first) ?? undefined },
    source: "inferred",
    markets: live.length,
  };
}

/**
 * A binary market's authoritative on-chain snapshot, resolved by its bytes32
 * `marketId` (settlement-extraction v2: a pool address is a time-varying
 * binding, so `getMarketOnchain` rejects a raw address). Returns null for
 * non-binary rows. This snapshot (pool, nonce, outcome ids, status) is the ONE
 * generation to act on for a pass — reuse it across your reads/writes so you
 * never straddle a pool recycle.
 */
export async function marketOnchain(ctx: EcContext, market: UnifiedMarket): Promise<MarketOnchain | null> {
  if (market.info.marketType !== "BINARY") return null;
  return ctx.exchange.client.getMarketOnchain(market.info.marketId as Hex);
}

/** The YES / NO tradable symbols for a binary market (outcome 0 = YES, 1 = NO). */
export function outcomeSymbols(market: UnifiedMarket): { yes: string; no: string } {
  const outs = market.outcomes ?? [];
  return { yes: outs[0]?.symbol ?? `${market.symbol}#YES`, no: outs[1]?.symbol ?? `${market.symbol}#NO` };
}

/** Gate writes on the authoritative on-chain status — never the indexer status
 *  (which lags). Only `Trading` accepts orders. */
export const isTradable = (onchain: MarketOnchain): boolean => onchain.status === MARKET_STATUS.Trading;

/** A live YES-book snapshot (human units). Prices are YES probabilities in (0,1). */
export interface EcSnapshot {
  bestYesBid?: number;
  bestYesAsk?: number;
  yesMid?: number;
}

/** One-shot YES-book snapshot for a market. Use the YES outcome symbol. */
export async function snapshot(ctx: EcContext, yesSymbol: string, depth = 5): Promise<EcSnapshot> {
  const ob = await ctx.exchange.fetchOrderBook(yesSymbol, depth);
  const bestYesBid = ob.bids[0]?.[0];
  const bestYesAsk = ob.asks[0]?.[0];
  const yesMid = bestYesBid !== undefined && bestYesAsk !== undefined ? (bestYesBid + bestYesAsk) / 2 : (bestYesBid ?? bestYesAsk);
  return { bestYesBid, bestYesAsk, yesMid };
}

/** Human share amount → raw units (10^decimals), exact for any decimals (goes
 *  through toFixed so fractional sizes survive without float→BigInt loss). */
export function toRawUnits(human: number, decimals: number): bigint {
  const [i, f = ""] = human.toFixed(decimals).split(".");
  return BigInt(i + f.padEnd(decimals, "0"));
}

/**
 * Snap an order size DOWN to the venue's lot grid (`MM_LOT`).
 *
 * Use this rather than the SDK's `exchange.amountToPrecision()`, which floors to
 * the same 0.001-share lot on markets-sdk 0.30.0 but cannot see an `MM_LOT`
 * override. The lot is 1e3 raw on the 6-decimal testnet and 1e15 on the
 * 18-decimal mainnet USDso venue.
 *
 * How strict the grid actually is varies by venue, so this trusts `MM_LOT`
 * rather than guessing. Returns 0 when the amount is below one lot; callers
 * must skip, not send.
 *
 * On the 18-decimal mainnet venue the returned size can be SMALLER than you
 * asked for (0.05 → 0.047, 0.137 → 0.125). `toRawUnits` converts through
 * `toFixed(18)`, and most decimals don't survive that exactly (0.05 becomes
 * …0003, which is off the lot grid and the book rejects), so this returns the
 * largest size whose `toRawUnits` is an exact lot multiple. If you need an exact
 * quantity, bypass the float path and use the raw trader:
 * `ctx.exchange.trader.placeOrder({ …, quantity })` takes a bigint directly.
 */
export function quantize(ctx: EcContext, human: number): number {
  const { lot, decimals } = ctx.config;
  const lotHuman = Number(lot) / 10 ** decimals;
  if (!(human > 0) || lotHuman <= 0) return 0;
  const lots = Math.floor(human / lotHuman + 1e-9);
  if (lots < 1) return 0;
  // A float can land a wei off the raw grid once toFixed rounds it, and the book
  // rejects that — walk down to the nearest size that is an exact lot multiple.
  for (let n = lots; n >= 1; n--) {
    const size = Number((n * lotHuman).toFixed(decimals));
    if (toRawUnits(size, decimals) % lot === 0n) return size;
  }
  return 0;
}

/**
 * Recently settled markets in scope, newest first — the ones holding unclaimed
 * winnings.
 *
 * `loadMarkets()` cannot answer this. Since markets-sdk 0.20 the registry sweep
 * skips finalized binaries to keep itself small, so a settled market simply is
 * not in it: filtering `loadMarkets()` for inactive rows returns nothing, and a
 * bot scanning for its own winnings finds none. The binary tier can, though:
 * `"Finalized"` is the indexer's terminal status for a settled binary, and
 * `listBinaryMarkets` takes it by name.
 *
 * Returns the ids to hand to `getMarketOnchain`, plus enough to log usefully.
 */
export async function settledMarkets(
  ctx: EcContext,
  limit = 40,
): Promise<{ marketId: Hex; symbol: string; expiry: number }[]> {
  const want = Math.max(1, Math.min(200, limit));
  const scope = ctx.config.venueId
    ? { venueId: ctx.config.venueId }
    : ctx.config.operatorId !== undefined
      ? { operatorId: ctx.config.operatorId }
      : null;
  if (!scope) {
    // `activeMarkets` refuses this ambiguity rather than trade a venue you did
    // not mean; claiming had been quietly sweeping every venue on the
    // deployment. Same rule, so the two agree on what "our markets" means.
    const venues = new Set(
      (await ctx.exchange.client.listBinaryMarkets({ status: "Finalized", limit: 50 }))
        .map((r) => String(r.venueId ?? "").toLowerCase())
        .filter(Boolean),
    );
    if (venues.size > 1) {
      throw new Error(
        `Settled markets span ${venues.size} venues. Set VENUE_ID (or OPERATOR_ID) in .env ` +
          `so claiming looks at the same venue the bot trades.`,
      );
    }
  }
  const rows = await ctx.exchange.client.listBinaryMarkets({
    ...(scope ?? {}),
    status: "Finalized",
    // Over-fetch: the server sorts newest-CREATED, we want newest-EXPIRED. Those
    // orders agree within a series but not across series of different cadences,
    // so cutting at `want` server-side would drop recent settlements off the
    // edge. Sort locally, then cut.
    limit: Math.min(200, want * 3),
  });
  return rows
    .map((r) => ({
      marketId: r.marketId as Hex,
      symbol: `${r.asset ?? "?"} ${r.intervalSec ?? "?"}s @${r.expiry}`,
      expiry: Number(r.expiry ?? 0),
    }))
    .sort((a, b) => b.expiry - a.expiry)
    .slice(0, want);
}

/**
 * Why the venue scope came back empty, in a sentence the operator can act on.
 *
 * Silence is the wrong answer here. Venue ids move — both networks changed
 * theirs three times in one week — and a bot pointed at a stale one simply
 * finds nothing, forever, with nothing in the log to say so. This separates
 * "the indexer has no live binaries" from "it has them, your scope excludes
 * them", which are different fixes.
 */
export async function explainEmptyScope(ctx: EcContext): Promise<string> {
  const { network, venueId, operatorId } = ctx.config;
  let all: UnifiedMarket[];
  try {
    all = Object.values(await ctx.exchange.loadMarkets(true));
  } catch (e) {
    return `could not read the market list: ${(e as Error).message}`;
  }
  const binary = all.filter((m) => m.type === "binary");
  const live = binary.filter((m) => m.active);
  if (live.length === 0) {
    return (
      `indexer shows 0 active binary markets on ${network} (${binary.length} binary rows loaded). ` +
      `Check NETWORK=testnet|mainnet in .env, and read VENUE_ID off a live market row (docs/event-contracts.md).`
    );
  }
  return (
    `${live.length} active binary market(s) exist, but none matched this venue scope ` +
    `(venueId=${venueId ?? "unset"} operatorId=${operatorId ?? "unset"}). ` +
    `The venue ids move — read VENUE_ID off a live market row (docs/event-contracts.md).`
  );
}
