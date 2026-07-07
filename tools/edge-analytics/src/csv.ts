/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Loaders that turn logs into the analytics domain types.
//
// The primary input is the kit's own csv-logger output (the `TradeRow` shape
// from examples/02-modular-typescript): one row per lifecycle action, columns
//   ts,network,pool,side,action,orderId,price,qty,notional,txHash,note
// so this example plugs straight into a bot you're already running.
//
// A second, optional input is a mid-price CSV (ts,mid) produced by polling the
// book (SpotPool.getBookLevels / the WS book channel). If you don't have one,
// pass `--mid-from-trades` and we approximate it from a trades CSV.

import { readFileSync } from "node:fs";
import type { ActionCounts, Fill, MidTick } from "./types.js";

/** Parse a unix timestamp that may be seconds, milliseconds, or ISO-8601. */
export function parseTs(raw: string): number {
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    // Heuristic: 10-digit = seconds, 13-digit = ms.
    return s.length <= 10 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`unparseable timestamp: ${raw}`);
  return t;
}

/** Minimal CSV split honouring double-quoted fields (matches the kit's escaper). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function readRows(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((ln) => {
    const cells = splitCsvLine(ln);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

const toFillSide = (s: string): Fill["side"] =>
  s === "bid" || s === "buy" ? "buy" : "sell";

/**
 * Load fills + per-pool action counts from a kit csv-logger `TradeRow` file.
 * Only `action=fill` rows become fills; `post`/`cancel`/`reduce`/`fill` rows all
 * feed the transactions-per-fill counters.
 */
export function loadTradeRows(path: string): {
  fills: Fill[];
  actions: ActionCounts[];
} {
  const rows = readRows(path);
  const fills: Fill[] = [];
  const byPool = new Map<string, ActionCounts>();
  const bump = (pool: string, k: keyof Omit<ActionCounts, "pool">): void => {
    const a =
      byPool.get(pool) ??
      byPool.set(pool, { pool, post: 0, cancel: 0, reduce: 0, fill: 0 }).get(pool)!;
    a[k]++;
  };
  for (const r of rows) {
    const pool = r.pool ?? "";
    const action = r.action ?? "";
    if (action === "post" || action === "cancel" || action === "reduce" || action === "fill") {
      bump(pool, action);
    }
    if (action === "fill") {
      const price = Number(r.price);
      const qty = Number(r.qty);
      if (Number.isFinite(price) && Number.isFinite(qty) && price > 0) {
        fills.push({
          tsMs: parseTs(r.ts ?? ""),
          pool,
          side: toFillSide(r.side ?? ""),
          price,
          qty,
          orderId: r.orderId || undefined,
        });
      }
    }
  }
  return {
    fills: fills.sort((a, b) => a.tsMs - b.tsMs),
    actions: [...byPool.values()],
  };
}

/** Load a mid-price CSV. Accepts headers `ts,mid` (extra columns ignored). */
export function loadMidCsv(path: string): MidTick[] {
  return readRows(path)
    .map((r) => ({ tsMs: parseTs(r.ts ?? ""), mid: Number(r.mid) }))
    .filter((t) => Number.isFinite(t.tsMs) && Number.isFinite(t.mid) && t.mid > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
}

/** Load a trades CSV (`ts,price[,...]`) for the mid-from-trades approximation. */
export function loadTradesCsv(path: string): Array<{ tsMs: number; price: number }> {
  return readRows(path)
    .map((r) => ({ tsMs: parseTs(r.ts ?? ""), price: Number(r.price) }))
    .filter((t) => Number.isFinite(t.tsMs) && Number.isFinite(t.price) && t.price > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
}
