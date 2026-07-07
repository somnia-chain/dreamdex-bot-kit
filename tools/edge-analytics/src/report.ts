/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Aggregation + verdict. Turns per-fill markouts and action counts into the
// three numbers that decide whether a maker has an edge:
//
//   1. captured spread (bps)      — what you earn at the touch
//   2. adverse selection (bps)    — what the market takes back after you trade
//   3. transactions per fill      — how much gas you burn to earn #1
//
// If captured + adverse < 0, no amount of parameter tuning saves the strategy —
// the core is negative and you're choosing between two ways to lose. If it's
// positive but transactions-per-fill is high, gas may still eat the edge; price
// it in explicitly (see README, "Don't forget gas").

import type { ActionCounts, Fill, Markout } from "./types.js";

export interface HorizonStat {
  horizonMs: number;
  /** Fills that had valid mid data at this horizon. */
  n: number;
  medianMoveBps: number;
  meanMoveBps: number;
  medianNetBps: number;
  meanNetBps: number;
  /** Share of total adverse drift caused by the worst 10% of fills (Pareto). */
  worstDecileShare: number;
}

export interface EdgeReport {
  fills: number;
  fillsWithMid: number;
  medianCapturedBps: number;
  meanCapturedBps: number;
  horizons: HorizonStat[];
  transactionsPerFill: number | null;
  actionTotals: { post: number; cancel: number; reduce: number; fill: number };
  /** Human-readable go/no-go, keyed off the longest horizon's median net. */
  verdict: string;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

/** Share of total adverse (negative) drift concentrated in the worst decile. */
function paretoWorstDecile(moves: number[]): number {
  const adverse = moves.filter((m) => m < 0).map((m) => -m); // magnitudes
  if (adverse.length === 0) return 0;
  const total = adverse.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const sorted = [...adverse].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(sorted.length * 0.1));
  const top = sorted.slice(0, k).reduce((a, b) => a + b, 0);
  return top / total;
}

export function buildReport(
  markouts: Markout[],
  actions: ActionCounts[] = [],
): EdgeReport {
  const captured = markouts
    .map((m) => m.capturedBps)
    .filter((x): x is number => x !== null);

  const horizonsMs = markouts.length
    ? Object.keys(markouts[0]!.moveBps).map(Number).sort((a, b) => a - b)
    : [];

  const horizons: HorizonStat[] = horizonsMs.map((h) => {
    const moves = markouts
      .map((m) => m.moveBps[h])
      .filter((x): x is number => x !== null && x !== undefined);
    const nets = markouts
      .map((m) => m.netBps[h])
      .filter((x): x is number => x !== null && x !== undefined);
    return {
      horizonMs: h,
      n: moves.length,
      medianMoveBps: median(moves),
      meanMoveBps: mean(moves),
      medianNetBps: median(nets),
      meanNetBps: mean(nets),
      worstDecileShare: paretoWorstDecile(moves),
    };
  });

  const totals = actions.reduce(
    (a, c) => ({
      post: a.post + c.post,
      cancel: a.cancel + c.cancel,
      reduce: a.reduce + c.reduce,
      fill: a.fill + c.fill,
    }),
    { post: 0, cancel: 0, reduce: 0, fill: 0 },
  );
  const txs = totals.post + totals.cancel + totals.reduce;
  const transactionsPerFill = totals.fill > 0 ? txs / totals.fill : null;

  const last = horizons[horizons.length - 1];
  const verdict = makeVerdict(median(captured), last, transactionsPerFill);

  return {
    fills: markouts.length,
    fillsWithMid: captured.length,
    medianCapturedBps: median(captured),
    meanCapturedBps: mean(captured),
    horizons,
    transactionsPerFill,
    actionTotals: totals,
    verdict,
  };
}

function makeVerdict(
  medCaptured: number,
  last: HorizonStat | undefined,
  txPerFill: number | null,
): string {
  if (!last || Number.isNaN(last.medianNetBps)) {
    return "INSUFFICIENT DATA — no fills had mid-price coverage at the longest horizon.";
  }
  const net = last.medianNetBps;
  const hs = (last.horizonMs / 1000).toFixed(0);
  const parts: string[] = [];
  if (net < 0) {
    parts.push(
      `NEGATIVE EDGE: median net ${net.toFixed(1)} bps at ${hs}s ` +
        `(captured ${medCaptured.toFixed(1)} bps, adverse selection ${last.medianMoveBps.toFixed(1)} bps). ` +
        `Adverse selection exceeds the spread — tuning params won't fix this; change the edge.`,
    );
  } else {
    parts.push(
      `Positive marked-to-mid edge: median net +${net.toFixed(1)} bps at ${hs}s ` +
        `(captured ${medCaptured.toFixed(1)} bps, adverse selection ${last.medianMoveBps.toFixed(1)} bps).`,
    );
  }
  if (txPerFill !== null && txPerFill > 10) {
    parts.push(
      `WARNING: ${txPerFill.toFixed(0)} transactions per fill — gas may eat the edge even if it's positive. ` +
        `Requote less (only on moves > spread) or use reduceOrder/EIP-7702 batching.`,
    );
  }
  return parts.join(" ");
}

/** Pretty-print a report to a string (used by the CLI). */
export function formatReport(r: EdgeReport, midProxyNote = false): string {
  const L: string[] = [];
  L.push("── DreamDEX edge report ─────────────────────────────────────────");
  L.push(`fills: ${r.fills}  (with mid coverage: ${r.fillsWithMid})`);
  L.push(
    `captured spread:  median ${r.medianCapturedBps.toFixed(2)} bps   mean ${r.meanCapturedBps.toFixed(2)} bps`,
  );
  L.push("");
  L.push("adverse selection & net edge, marked to mid:");
  L.push("  horizon |   n  | adverse (med) | net (med) | net (mean) | worst-10% share");
  for (const h of r.horizons) {
    L.push(
      `  ${(h.horizonMs / 1000).toFixed(0).padStart(5)}s | ${String(h.n).padStart(4)} | ` +
        `${h.medianMoveBps.toFixed(1).padStart(11)} bps | ${h.medianNetBps.toFixed(1).padStart(6)} bps | ` +
        `${h.meanNetBps.toFixed(1).padStart(6)} bps | ${(h.worstDecileShare * 100).toFixed(0).padStart(3)}%`,
    );
  }
  L.push("");
  if (r.transactionsPerFill !== null) {
    L.push(
      `transactions per fill: ${r.transactionsPerFill.toFixed(1)}  ` +
        `(post ${r.actionTotals.post}, cancel ${r.actionTotals.cancel}, reduce ${r.actionTotals.reduce}, fill ${r.actionTotals.fill})`,
    );
  } else {
    L.push("transactions per fill: n/a (no post/cancel/fill actions in the log)");
  }
  L.push("");
  L.push(`VERDICT: ${r.verdict}`);
  if (midProxyNote) {
    L.push("");
    L.push(
      "NOTE: mid path was approximated from the trade tape (no book snapshots). " +
        "Adverse selection is UNDERSTATED — treat these as a lower bound.",
    );
  }
  L.push("─────────────────────────────────────────────────────────────────");
  return L.join("\n");
}
