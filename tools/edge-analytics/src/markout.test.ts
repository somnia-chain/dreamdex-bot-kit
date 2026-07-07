/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { describe, it, expect } from "vitest";
import { midAt, markoutFill, midSeriesFromTrades } from "./markout.js";
import { buildReport } from "./report.js";
import type { Fill, MidTick, ActionCounts } from "./types.js";

describe("midAt", () => {
  const mids: MidTick[] = [
    { tsMs: 0, mid: 100 },
    { tsMs: 1_000, mid: 101 },
    { tsMs: 2_000, mid: 102 },
  ];
  it("returns the nearest tick within staleness", () => {
    expect(midAt(mids, 1_100, 5_000)).toBe(101);
    expect(midAt(mids, 1_900, 5_000)).toBe(102);
  });
  it("returns null when the nearest tick is too stale", () => {
    expect(midAt(mids, 10_000, 1_000)).toBeNull();
  });
  it("handles targets before the series start", () => {
    expect(midAt(mids, -500, 1_000)).toBe(100);
    expect(midAt(mids, -5_000, 1_000)).toBeNull();
  });
});

describe("markoutFill — a toxic buy", () => {
  // We bought at 100 while mid was 100.5 (captured +~49.75 bps), then the mid
  // fell to 99.5 one second later (adverse ~-99.5 bps) => net ~-49.75 bps.
  const fill: Fill = { tsMs: 0, pool: "p", side: "buy", price: 100, qty: 1 };
  const mids: MidTick[] = [
    { tsMs: 0, mid: 100.5 },
    { tsMs: 1_000, mid: 99.5 },
  ];
  const m = markoutFill(fill, mids, [1_000], 5_000);

  it("captures a positive half-spread at the touch", () => {
    expect(m.capturedBps).toBeCloseTo((0.5 / 100.5) * 1e4, 2);
    expect(m.capturedBps!).toBeGreaterThan(0);
  });
  it("reports negative adverse-selection drift", () => {
    expect(m.moveBps[1_000]).toBeCloseTo((-1 / 100.5) * 1e4, 2);
    expect(m.moveBps[1_000]!).toBeLessThan(0);
  });
  it("nets out negative (adverse selection > captured spread)", () => {
    expect(m.netBps[1_000]!).toBeLessThan(0);
    expect(m.netBps[1_000]).toBeCloseTo(m.capturedBps! + m.moveBps[1_000]!, 6);
  });
});

describe("markoutFill — sell side sign convention", () => {
  // Sold at 101 while mid was 100.5 (captured +~49.75 bps), mid rose to 101.5
  // afterwards (adverse for a short => negative move).
  const fill: Fill = { tsMs: 0, pool: "p", side: "sell", price: 101, qty: 1 };
  const mids: MidTick[] = [
    { tsMs: 0, mid: 100.5 },
    { tsMs: 1_000, mid: 101.5 },
  ];
  const m = markoutFill(fill, mids, [1_000], 5_000);
  it("captures positive spread selling above mid", () => {
    expect(m.capturedBps!).toBeGreaterThan(0);
  });
  it("marks the upward move as adverse for the seller", () => {
    expect(m.moveBps[1_000]!).toBeLessThan(0);
  });
});

describe("buildReport — transactions per fill", () => {
  const fill: Fill = { tsMs: 0, pool: "p", side: "buy", price: 100, qty: 1 };
  const mids: MidTick[] = [
    { tsMs: 0, mid: 100 },
    { tsMs: 1_000, mid: 100 },
  ];
  const actions: ActionCounts[] = [
    { pool: "p", post: 30, cancel: 25, reduce: 0, fill: 5 },
  ];
  it("divides total txs by fills", () => {
    const r = buildReport(
      Array.from({ length: 5 }, () => markoutFill(fill, mids, [1_000], 5_000)),
      actions,
    );
    expect(r.transactionsPerFill).toBeCloseTo((30 + 25) / 5, 6);
    expect(r.verdict).toMatch(/transactions per fill|WARNING/i);
  });
});

describe("midSeriesFromTrades", () => {
  it("sorts and maps trade prices to a mid proxy", () => {
    const s = midSeriesFromTrades([
      { tsMs: 2_000, price: 2 },
      { tsMs: 1_000, price: 1 },
    ]);
    expect(s.map((t) => t.tsMs)).toEqual([1_000, 2_000]);
    expect(s[0]!.mid).toBe(1);
  });
});
