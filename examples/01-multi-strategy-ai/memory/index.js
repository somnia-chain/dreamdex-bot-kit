/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { log } from '../utils/logger.js';

const DATA_DIR = CONFIG.DATA_DIR;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJSON(filename) {
  ensureDir();
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (e) {
    log('warn', 'memory', `Failed to read ${filename}: ${e.message}`);
  }
  return null;
}

function writeJSON(filename, data) {
  ensureDir();
  const filepath = path.join(DATA_DIR, filename);
  const tmp = filepath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filepath);
  } catch (e) {
    log('error', 'memory', `Failed to write ${filename}: ${e.message}`);
  }
}

const STATE_FILE = 'state.json';
const TRADES_FILE = 'trades.json';
const SNAPSHOTS_FILE = 'snapshots.json';
const COINGECKO_SNAPSHOTS_FILE = 'coingecko_snapshots.json';

// --- STATE ---

export function getState() {
  return readJSON(STATE_FILE) || {};
}

export function setState(key, value) {
  const state = getState();
  state[key] = value;
  state.updatedAt = new Date().toISOString();
  writeJSON(STATE_FILE, state);
}

export function isInitialDepositDone() {
  return !!getState().initialDepositDone;
}

export function markInitialDeposit(usdsoAmount) {
  setState('initialDepositDone', true);
  setState('initialBalance', usdsoAmount);
  setState('cumulativePnl', 0);
  setState('circuitBreakerHalted', false);
  setState('botStartedAt', new Date().toISOString());
}

export function isCircuitBreakerHalted() {
  return !!getState().circuitBreakerHalted;
}

export function haltBot(reason) {
  setState('circuitBreakerHalted', true);
  setState('haltReason', reason);
  setState('haltedAt', new Date().toISOString());
}

// --- TRADES ---

export function addTrade(trade) {
  const trades = readJSON(TRADES_FILE) || [];
  trade.id = `TRADE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  trade.timestamp = new Date().toISOString();
  trades.push(trade);
  writeJSON(TRADES_FILE, trades);
  return trade;
}

export function getTrades(limit = 50) {
  const trades = readJSON(TRADES_FILE) || [];
  return trades.slice(-limit);
}

export function updateTrade(id, updates) {
  const trades = readJSON(TRADES_FILE) || [];
  const idx = trades.findIndex((t) => t.id === id);
  if (idx !== -1) {
    trades[idx] = { ...trades[idx], ...updates };
    writeJSON(TRADES_FILE, trades);
    return trades[idx];
  }
  return null;
}

export function getOpenPositions() {
  const trades = readJSON(TRADES_FILE) || [];
  return trades.filter((t) => t.status === 'OPEN');
}

export function closePosition(positionId, exitPrice, exitTxHash) {
  const trade = updateTrade(positionId, {
    status: 'CLOSED',
    exitPrice,
    exitTxHash,
    closedAt: new Date().toISOString(),
  });

  if (trade) {
    const pnl = trade.side === 'BUY'
      ? (exitPrice - trade.entryPrice) * trade.amount
      : (trade.entryPrice - exitPrice) * trade.amount;
    updateTrade(positionId, { pnl });

    const state = getState();
    const cumulativePnl = (state.cumulativePnl || 0) + pnl;
    setState('cumulativePnl', cumulativePnl);
    return { ...trade, pnl, cumulativePnl };
  }
  return null;
}

export function getStrategyStats() {
  const trades = readJSON(TRADES_FILE) || [];
  const closed = trades.filter((t) => t.status === 'CLOSED');

  const stats = {
    totalTrades: trades.length,
    closedTrades: closed.length,
    overallWinRate: 0,
    grid: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgReturn: 0, totalPnl: 0 },
    momentum: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgReturn: 0, totalPnl: 0 },
    'mean reversion': { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgReturn: 0, totalPnl: 0 },
  };

  for (const t of closed) {
    const strat = (t.strategy || 'grid').toLowerCase();
    const bucket = stats[strat] || stats.grid;
    bucket.totalTrades++;
    if (t.pnl > 0) bucket.wins++;
    else bucket.losses++;
    bucket.totalPnl += t.pnl || 0;
  }

  for (const key of ['grid', 'momentum', 'mean reversion']) {
    const b = stats[key];
    if (b.totalTrades > 0) {
      b.winRate = ((b.wins / b.totalTrades) * 100).toFixed(1);
      b.avgReturn = ((b.totalPnl / b.totalTrades)).toFixed(4);
    }
  }

  if (closed.length > 0) {
    const overallWins = closed.filter((t) => t.pnl > 0).length;
    stats.overallWinRate = ((overallWins / closed.length) * 100).toFixed(1);
  }

  return stats;
}

// --- SNAPSHOTS ---

export function addSnapshot(marketData) {
  const snaps = readJSON(SNAPSHOTS_FILE) || [];
  snaps.push({
    timestamp: new Date().toISOString(),
    midPrice: marketData.midPrice,
    bid: marketData.bestBid,
    ask: marketData.bestAsk,
    spread: marketData.spread,
    vaultWeth: marketData.vaultBalances?.wethFree,
    vaultUsdso: marketData.vaultBalances?.usdsoFree,
  });

  if (snaps.length > 1000) {
    snaps.splice(0, snaps.length - 1000);
  }

  writeJSON(SNAPSHOTS_FILE, snaps);
}

export function addCoinGeckoSnapshot(cgData) {
  const snaps = readJSON(COINGECKO_SNAPSHOTS_FILE) || [];
  snaps.push({
    timestamp: new Date().toISOString(),
    btcPrice: cgData?.raw?.bitcoin?.currentPrice,
    btcChange24h: cgData?.raw?.bitcoin?.priceChange24h,
    btcRSI: cgData?.btcRSI,
    ethPrice: cgData?.raw?.ethereum?.currentPrice,
    ethChange24h: cgData?.raw?.ethereum?.priceChange24h,
    ethRSI: cgData?.ethRSI,
    sentiment: cgData?.sentiment?.signal,
    sentimentConfidence: cgData?.sentiment?.confidence,
  });

  if (snaps.length > 500) {
    snaps.splice(0, snaps.length - 500);
  }

  writeJSON(COINGECKO_SNAPSHOTS_FILE, snaps);
}

export function getRecentCoinGeckoSnapshots(limit = 30) {
  const snaps = readJSON(COINGECKO_SNAPSHOTS_FILE) || [];
  return snaps.slice(-limit);
}

export function getRecentSnapshots(limit = 30) {
  const snaps = readJSON(SNAPSHOTS_FILE) || [];
  return snaps.slice(-limit);
}
