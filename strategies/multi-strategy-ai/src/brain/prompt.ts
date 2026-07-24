/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { MarketSnapshot, SignalResult } from "../types.js";

export const SYSTEM_PROMPT = `You are a trading decision engine for a DreamDEX spot CLOB bot.
You receive classical strategy signals (momentum, mean-reversion, grid) plus a market snapshot.
Respond with a single JSON object ONLY — no markdown, no commentary.
Schema:
{"action":"BUY"|"SELL"|"HOLD","strategy":"MOMENTUM"|"MEAN_REVERSION"|"GRID","price":number,"amount":number,"stopLoss":number,"takeProfit":number,"confidence":0-1,"reasoning":"short"}
Prefer HOLD when signals conflict or confidence is low. Spot only — SELL means sell base inventory, not short.`;

export function buildDecisionPrompt(signals: SignalResult[], snap: MarketSnapshot): string {
  const lines = signals.map((s) => {
    const conf = s.confidence.toFixed(2);
    return `- ${s.strategy}: ${s.signal} conf=${conf} — ${s.reason}`;
  });
  return `MARKET ${snap.symbol}
mid=${snap.mid.toFixed(6)} bid=${snap.bestBid?.toFixed(6) ?? "n/a"} ask=${snap.bestAsk?.toFixed(6) ?? "n/a"}
baseInventory=${snap.baseInventory.toFixed(6)} quoteInventory=${snap.quoteInventory.toFixed(4)}
samples=${snap.mids.length}

SIGNALS:
${lines.join("\n")}

Respond with valid JSON only.`;
}
