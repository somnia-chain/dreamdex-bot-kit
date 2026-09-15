/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Market resolution and the unit conversions every perp write needs.
//
// Two symbol dialects meet here. A trader reads `BTC-PERP` off the URL bar and
// the market header, and that is what the builder writes into .env. The SDK
// speaks ccxt, where the same market is `BTC/USDso:USDso` and its `type` is
// `"swap"`, not `"perp"`. Everything below takes the first and returns the
// second, so a strategy never has to know.

import type { SomniaMarkets, UnifiedMarket } from "@somnia-chain/markets-sdk";

/** The fields a perp strategy reads off a market row. */
export interface PerpInfo {
  poolAddress: `0x${string}`;
  marginBank: `0x${string}`;
  quoteToken: `0x${string}`;
  baseToken: `0x${string}`;
  baseSymbol: string;
  quoteSymbol: string;
  /** Size decimals. Runs 6, 7, 8, 9, 18 and 24 across the live markets. */
  baseDecimals: number;
  quoteDecimals: number;
  /** Prices are ALWAYS 18 decimals, whatever baseDecimals is. */
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  fundingWindowSec: number;
  fundingIntervalSec: number;
  initialMarginBps: number;
  openInterest: string;
  /** This market's own stop registry. There is no shared one. */
  stopRegistry: `0x${string}`;
}

export interface PerpMarket {
  /** ccxt symbol, e.g. "BTC/USDso:USDso". */
  symbol: string;
  /** App-canonical name, e.g. "BTC-PERP". */
  display: string;
  info: PerpInfo;
  market: UnifiedMarket;
}

/** "BTC/USDso:USDso" -> "BTC-PERP". */
export function displayName(symbol: string): string {
  const base = symbol.split("/")[0] ?? symbol;
  return `${base}-PERP`;
}

/** "BTC-PERP", "btc-perp", "BTC" and "BTC/USDso:USDso" all mean the same base. */
function baseOf(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (trimmed.includes("/")) return trimmed.split("/")[0] ?? trimmed;
  return trimmed.replace(/-PERP$/, "");
}

function asPerp(market: UnifiedMarket): PerpMarket {
  return {
    symbol: market.symbol,
    display: displayName(market.symbol),
    info: market.info as unknown as PerpInfo,
    market,
  };
}

/**
 * Every live perp market.
 *
 * Perps arrive as ccxt **swaps**; filtering on `"perp"` returns nothing and
 * reads as an empty exchange. `active` is derived from the pool's own gates, so
 * an inactive market is one the venue has stopped, not one the indexer missed.
 */
export async function perpMarkets(exchange: SomniaMarkets, reload = false): Promise<PerpMarket[]> {
  // `loadMarkets()` serves a cached registry. A polling loop that omits the
  // reload flag reads the mark, the funding rate and the open interest it saw
  // at startup, forever, which looks like a frozen market rather than a stale
  // cache.
  const markets = await exchange.loadMarkets(reload);
  return Object.values(markets)
    .filter((m) => m.type === "swap" && m.active)
    .map(asPerp);
}

/**
 * Resolve the configured symbol to one market.
 *
 * Throws with the list of what IS live rather than returning undefined, because
 * a typo in PERP_SYMBOL otherwise surfaces later as "no position to manage",
 * which reads like a funding problem.
 */
export async function requireMarket(
  exchange: SomniaMarkets,
  symbol: string,
  opts: { reload?: boolean } = {},
): Promise<PerpMarket> {
  const wanted = baseOf(symbol);
  if (!wanted) {
    throw new Error("PERP_SYMBOL is empty. Set it to a market such as BTC-PERP.");
  }
  const all = await perpMarkets(exchange, opts.reload ?? false);
  const hit = all.find((m) => baseOf(m.symbol) === wanted);
  if (hit) return hit;
  const names = all.map((m) => m.display).join(", ");
  throw new Error(
    `PERP_SYMBOL="${symbol}" does not match a live perp market. Live markets: ${names || "(none)"}.`,
  );
}

/**
 * Human number to raw units, on the grid.
 *
 * `parseUnits(x.toFixed(18), 18)` is the obvious conversion and it is wrong:
 * `(0.0888).toFixed(18)` is "0.088800000000000004", four wei off the tick grid,
 * which the pool rejects as `InvalidPrice`. Fixing to fewer places than the grid
 * needs round-trips exactly.
 */
export function toRaw(human: number, decimals: number): bigint {
  const s = human.toFixed(Math.min(decimals, 9));
  const [i = "0", f = ""] = s.split(".");
  const negative = i.startsWith("-");
  const digits = (negative ? i.slice(1) : i) + f.padEnd(decimals, "0").slice(0, decimals);
  const raw = BigInt(digits || "0");
  return negative ? -raw : raw;
}

/** Raw units back to a human number, for logging only. */
export function fromRaw(raw: bigint | string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** Align a price DOWN to the market's tick grid. */
export function alignPrice(price: bigint, info: PerpInfo): bigint {
  const tick = BigInt(info.tickSize);
  if (tick <= 0n) return price;
  return (price / tick) * tick;
}

/**
 * Align a quantity DOWN to the lot grid, returning 0n when the result is below
 * the market's minimum. A size under `minQuantity` is not a small order, it is
 * no order, and saying so here keeps the caller from sending one.
 */
export function alignQuantity(quantity: bigint, info: PerpInfo): bigint {
  const lot = BigInt(info.lotSize);
  const min = BigInt(info.minQuantity);
  const aligned = lot > 0n ? (quantity / lot) * lot : quantity;
  return aligned < min ? 0n : aligned;
}

/**
 * The size, in base units, for a USDso notional at the current mark.
 *
 * `PERP_NOTIONAL_USDSO` is position value, not margin posted: at 2x leverage a
 * notional of 50 costs 25 in margin. The builder's help text says so, so the
 * kit reads it that way.
 */
export function sizeForNotional(notionalUsdso: number, info: PerpInfo, atMark?: number): bigint {
  // Pass the live mark wherever one is available: sizing off the row's stale
  // figure misstates the notional by however far the row has drifted.
  const mark = atMark && atMark > 0 ? atMark : Number(BigInt(info.markPrice)) / 1e18;
  if (!(mark > 0)) return 0n;
  return alignQuantity(toRaw(notionalUsdso / mark, info.baseDecimals), info);
}

/**
 * The mark price from the market ROW, as a human number.
 *
 * Measured on the live testnet indexer: this field lags the chain by tens of
 * minutes, because the row is rewritten on market events rather than on every
 * oracle push. Across the live markets the gap reached 0.96% while the row's
 * timestamp sat 30 to 55 minutes behind. It is fine for a log line and wrong
 * for anything that prices an order or a trigger.
 *
 * Use {@link liveMark} for those.
 */
export function markOf(info: PerpInfo): number {
  return Number(BigInt(info.markPrice)) / 1e18;
}

/** Seconds since the row's mark was written, or Infinity when it carries no timestamp. */
export function markAgeSec(info: PerpInfo & { markPriceUpdatedAt?: number | string }): number {
  const at = Number(info.markPriceUpdatedAt ?? 0);
  if (!at) return Number.POSITIVE_INFINITY;
  return Math.floor(Date.now() / 1000) - at;
}

/**
 * The mark price the POOL will act on, read from the chain.
 *
 * This is the number every trigger, liquidation and margin check is evaluated
 * against, so it is the one to price against. Returns `undefined` while the
 * market is un-priceable, which is a state to handle rather than a failure: a
 * stale oracle rejects opens and withdrawals but still accepts reducing orders.
 */
export async function liveMark(exchange: SomniaMarkets, market: PerpMarket): Promise<number | undefined> {
  try {
    const snapshot = await exchange.client.getPerpHealthSnapshot(market.info.poolAddress);
    // The snapshot is a union on `priceable`: when the mark is stale there are
    // no other fields to read, so narrowing is not optional here.
    if (!snapshot.priceable) return undefined;
    const raw = Number(snapshot.markPrice);
    return raw > 0 ? raw / 1e18 : undefined;
  } catch {
    return undefined;
  }
}

/** The index price as a human number. */
export function indexOf(info: PerpInfo): number {
  return Number(BigInt(info.indexPrice)) / 1e18;
}
