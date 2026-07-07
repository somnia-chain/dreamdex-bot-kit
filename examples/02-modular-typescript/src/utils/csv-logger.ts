/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LOGGING } from "../config/constants.js";
import { logger } from "./logger.js";

export interface TradeRow {
  ts: string;
  network: string;
  pool: string;
  side: "bid" | "ask" | "buy" | "sell";
  action: "post" | "cancel" | "fill" | "expire" | "error";
  orderId?: string;
  price?: number;
  qty?: number;
  notional?: number;
  txHash?: string;
  note?: string;
}

const HEADER =
  "ts,network,pool,side,action,orderId,price,qty,notional,txHash,note\n";

let initialized = false;

async function ensureFile(path: string): Promise<void> {
  if (initialized) return;
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    /* dir may exist */
  }
  try {
    await appendFile(path, "", { flag: "a" });
    const stat = await import("node:fs").then((fs) => fs.promises.stat(path));
    if (stat.size === 0) {
      await appendFile(path, HEADER);
    }
  } catch (err) {
    logger.error({ err, path }, "Failed to initialize CSV log");
  }
  initialized = true;
}

function escape(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function logTrade(row: TradeRow): Promise<void> {
  const path = LOGGING.csvTradeLog;
  await ensureFile(path);
  const line = [
    row.ts,
    row.network,
    row.pool,
    row.side,
    row.action,
    row.orderId ?? "",
    row.price ?? "",
    row.qty ?? "",
    row.notional ?? "",
    row.txHash ?? "",
    row.note ?? "",
  ]
    .map(escape)
    .join(",") + "\n";
  try {
    await appendFile(path, line);
  } catch (err) {
    logger.error({ err, row }, "Failed to write CSV trade row");
  }
}
