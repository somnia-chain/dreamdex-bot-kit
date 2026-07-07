/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// The core measurement: markout / adverse selection.
//
// Market-making is a single inequality — you profit only if the spread you earn
// exceeds the adverse selection you suffer (Glosten–Milgrom, 1985). This module
// measures both terms directly from your own fills, so you can see the
// inequality instead of guessing at it.
//
// For each fill we decompose the mark-to-mid PnL at horizon h into:
//
//     netEdge(h)  =  capturedSpread  +  adverseMove(h)
//     ─────────────   ───────────────    ───────────────
//     sign*(midₕ−p)   sign*(mid₀−p)      sign*(midₕ−mid₀)
//
// where sign = +1 if we bought (a resting bid filled → we're long) and −1 if we
// sold. `capturedSpread` is what we're paid at the touch; `adverseMove` is where
// the market went while we held. A toxic fill has a large negative adverseMove
// that swamps the captured spread.

import type { Fill, MidTick, Markout, AnalyzeConfig, Horizons } from "./types.js";
import {
  DEFAULT_HORIZONS_MS,
  DEFAULT_MAX_MID_STALENESS_MS,
} from "./types.js";

const signOf = (side: Fill["side"]): 1 | -1 => (side === "buy" ? 1 : -1);
const bps = (x: number): number => x * 10_000;

/**
 * Nearest mid at or bracketing `targetMs`, via binary search over a
 * timestamp-sorted series. Returns null if the closest tick is staler than
 * `maxStalenessMs` — we never fabricate a price we didn't observe.
 */
export function midAt(
  mids: MidTick[],
  targetMs: number,
  maxStalenessMs: number,
): number | null {
  if (mids.length === 0) return null;
  let lo = 0;
  let hi = mids.length - 1;
  // Binary search for the last index with ts <= target.
  if (mids[lo]!.tsMs > targetMs) {
    // target before the series starts; only accept if first tick is close enough
    return mids[lo]!.tsMs - targetMs <= maxStalenessMs ? mids[lo]!.mid : null;
  }
  while (lo < hi) {
    const midIdx = (lo + hi + 1) >> 1;
    if (mids[midIdx]!.tsMs <= targetMs) lo = midIdx;
    else hi = midIdx - 1;
  }
  const before = mids[lo]!;
  const after = mids[lo + 1];
  // Pick whichever neighbour is closer in time.
  let best = before;
  if (after && Math.abs(after.tsMs - targetMs) < Math.abs(before.tsMs - targetMs)) {
    best = after;
  }
  return Math.abs(best.tsMs - targetMs) <= maxStalenessMs ? best.mid : null;
}

/** Compute the markout decomposition for a single fill. */
export function markoutFill(
  fill: Fill,
  mids: MidTick[],
  horizonsMs: Horizons,
  maxStalenessMs: number,
): Markout {
  const sign = signOf(fill.side);
  const mid0 = midAt(mids, fill.tsMs, maxStalenessMs);
  const capturedBps =
    mid0 === null || mid0 === 0 ? null : bps((sign * (mid0 - fill.price)) / mid0);

  const moveBps: Record<number, number | null> = {};
  const netBps: Record<number, number | null> = {};
  for (const h of horizonsMs) {
    const midH = midAt(mids, fill.tsMs + h, maxStalenessMs);
    if (mid0 === null || mid0 === 0 || midH === null) {
      moveBps[h] = null;
      netBps[h] = null;
      continue;
    }
    const move = bps((sign * (midH - mid0)) / mid0);
    moveBps[h] = move;
    netBps[h] = (capturedBps ?? 0) + move;
  }
  return { fill, mid0, capturedBps, moveBps, netBps };
}

/** Markout every fill. Mids must be sorted ascending by tsMs (see csv.ts). */
export function markoutFills(
  fills: Fill[],
  mids: MidTick[],
  cfg: AnalyzeConfig = {},
): Markout[] {
  const horizonsMs = cfg.horizonsMs ?? DEFAULT_HORIZONS_MS;
  const maxStalenessMs = cfg.maxMidStalenessMs ?? DEFAULT_MAX_MID_STALENESS_MS;
  return fills.map((f) => markoutFill(f, mids, horizonsMs, maxStalenessMs));
}

/**
 * Build a mid-price path from a trade tape when you have no book snapshots.
 * This is an APPROXIMATION: it uses each trade's price as a mid proxy. It is
 * good enough to see the SHAPE of adverse selection, but it understates it (a
 * trade prints at the touch, not the mid), so treat these numbers as a lower
 * bound and prefer a real book poller for anything you'll act on.
 */
export function midSeriesFromTrades(
  trades: Array<{ tsMs: number; price: number }>,
): MidTick[] {
  return trades
    .map((t) => ({ tsMs: t.tsMs, mid: t.price }))
    .sort((a, b) => a.tsMs - b.tsMs);
}
