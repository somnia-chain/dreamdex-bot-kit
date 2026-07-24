/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Decision, SignalResult, StrategyTag } from "./types.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const TRADES_PATH = join(DATA_DIR, "trades.json");
const STATS_PATH = join(DATA_DIR, "stats.json");

export interface TradeRecord {
  at: string;
  action: string;
  strategy: StrategyTag;
  price: number;
  amount: number;
  confidence: number;
  source: string;
  reasoning: string;
  dryRun: boolean;
  txHash?: string;
}

export interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export function loadStats(): Record<StrategyTag, StrategyStats> {
  return readJson(STATS_PATH, {
    MOMENTUM: { trades: 0, wins: 0, losses: 0 },
    MEAN_REVERSION: { trades: 0, wins: 0, losses: 0 },
    GRID: { trades: 0, wins: 0, losses: 0 },
  });
}

export function recordTrade(trade: TradeRecord): void {
  ensureDir();
  const trades = readJson<TradeRecord[]>(TRADES_PATH, []);
  trades.push(trade);
  writeJson(TRADES_PATH, trades.slice(-500));

  const stats = loadStats();
  const s = stats[trade.strategy] ?? { trades: 0, wins: 0, losses: 0 };
  s.trades += 1;
  stats[trade.strategy] = s;
  writeJson(STATS_PATH, stats);
}

export function recordOutcome(strategy: StrategyTag, pnlUsdso: number): void {
  const stats = loadStats();
  const s = stats[strategy] ?? { trades: 0, wins: 0, losses: 0 };
  if (pnlUsdso >= 0) s.wins += 1;
  else s.losses += 1;
  stats[strategy] = s;
  writeJson(STATS_PATH, stats);
}

export function recordSnapshot(signals: SignalResult[], decision: Decision): void {
  ensureDir();
  writeJson(join(DATA_DIR, "last-snapshot.json"), {
    at: new Date().toISOString(),
    signals,
    decision,
  });
}
