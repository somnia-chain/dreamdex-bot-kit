/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Config } from "../config.js";
import type { Decision, MarketSnapshot, SignalResult, StrategyTag } from "../types.js";
import { buildDecisionPrompt, SYSTEM_PROMPT } from "./prompt.js";

const HOLD: Decision = {
  action: "HOLD",
  strategy: "MOMENTUM",
  price: 0,
  amount: 0,
  stopLoss: 0,
  takeProfit: 0,
  confidence: 0,
  reasoning: "HOLD fallback",
  source: "vote",
};

/** Deterministic fusion when FEATURES_AI=false or the LLM fails. */
export function majorityVote(
  signals: SignalResult[],
  snap: MarketSnapshot,
  cfg: Config,
): Decision {
  const actionable = signals.filter((s) => s.signal !== "HOLD" && s.confidence > 0);
  if (actionable.length === 0) {
    return { ...HOLD, reasoning: "No actionable classical signals" };
  }

  const score = { BUY: 0, SELL: 0 };
  const best: Record<"BUY" | "SELL", SignalResult | undefined> = { BUY: undefined, SELL: undefined };
  for (const s of actionable) {
    if (s.signal !== "BUY" && s.signal !== "SELL") continue;
    score[s.signal] += s.confidence;
    const cur = best[s.signal];
    if (!cur || s.confidence > cur.confidence) best[s.signal] = s;
  }

  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (score.BUY > score.SELL && score.BUY > 0) action = "BUY";
  else if (score.SELL > score.BUY && score.SELL > 0) action = "SELL";
  else if (score.BUY === score.SELL && score.BUY > 0) {
    // Tie → pick higher single confidence; else HOLD.
    const b = best.BUY?.confidence ?? 0;
    const s = best.SELL?.confidence ?? 0;
    if (b > s) action = "BUY";
    else if (s > b) action = "SELL";
  }

  if (action === "HOLD") {
    return { ...HOLD, reasoning: "Signals tied or weak — HOLD" };
  }

  const winner = best[action]!;
  const price = action === "BUY" ? (snap.bestAsk ?? snap.mid) : (snap.bestBid ?? snap.mid);
  const amount = cfg.notionalUsdso / Math.max(price, 1e-12);
  const stopLoss =
    action === "BUY" ? price * (1 - cfg.stopLossPct) : price * (1 + cfg.stopLossPct);
  const takeProfit =
    action === "BUY" ? price * (1 + cfg.takeProfitPct) : price * (1 - cfg.takeProfitPct);

  return {
    action,
    strategy: winner.strategy,
    price,
    amount,
    stopLoss,
    takeProfit,
    confidence: winner.confidence,
    reasoning: `Majority vote → ${action} via ${winner.strategy}: ${winner.reason}`,
    source: "vote",
  };
}

function parseDecision(raw: string, snap: MarketSnapshot, cfg: Config): Decision | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const action = String(obj.action ?? "HOLD").toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") return null;

  const strategyRaw = String(obj.strategy ?? "MOMENTUM").toUpperCase().replace(/-/g, "_");
  const strategy: StrategyTag =
    strategyRaw === "MEAN_REVERSION" || strategyRaw === "GRID" || strategyRaw === "MOMENTUM"
      ? strategyRaw
      : "MOMENTUM";

  if (action === "HOLD") {
    return {
      ...HOLD,
      strategy,
      confidence: Number(obj.confidence) || 0,
      reasoning: String(obj.reasoning ?? "LLM HOLD"),
      source: "llm",
    };
  }

  const price =
    Number(obj.price) > 0
      ? Number(obj.price)
      : action === "BUY"
        ? (snap.bestAsk ?? snap.mid)
        : (snap.bestBid ?? snap.mid);
  const amount =
    Number(obj.amount) > 0 ? Number(obj.amount) : cfg.notionalUsdso / Math.max(price, 1e-12);
  const stopLoss =
    Number(obj.stopLoss) > 0
      ? Number(obj.stopLoss)
      : action === "BUY"
        ? price * (1 - cfg.stopLossPct)
        : price * (1 + cfg.stopLossPct);
  const takeProfit =
    Number(obj.takeProfit) > 0
      ? Number(obj.takeProfit)
      : action === "BUY"
        ? price * (1 + cfg.takeProfitPct)
        : price * (1 - cfg.takeProfitPct);

  return {
    action,
    strategy,
    price,
    amount,
    stopLoss,
    takeProfit,
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.5)),
    reasoning: String(obj.reasoning ?? "LLM decision"),
    source: "llm",
  };
}

export async function getLlmDecision(
  signals: SignalResult[],
  snap: MarketSnapshot,
  cfg: Config,
  log: (msg: string, extra?: unknown) => void,
): Promise<Decision> {
  if (!cfg.openai.apiKey && !cfg.openai.baseUrl.includes("127.0.0.1") && !cfg.openai.baseUrl.includes("localhost")) {
    log("LLM skipped — no OPENAI_API_KEY; falling back to majority vote");
    return majorityVote(signals, snap, cfg);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.openai.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.openai.apiKey) headers.Authorization = `Bearer ${cfg.openai.apiKey}`;

    const res = await fetch(`${cfg.openai.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.openai.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildDecisionPrompt(signals, snap) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`LLM HTTP ${res.status}`, body.slice(0, 200));
      return majorityVote(signals, snap, cfg);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseDecision(content, snap, cfg);
    if (!parsed) {
      log("LLM parse failed — majority vote fallback", content.slice(0, 200));
      return majorityVote(signals, snap, cfg);
    }
    return parsed;
  } catch (err) {
    log("LLM error — majority vote fallback", (err as Error).message);
    return majorityVote(signals, snap, cfg);
  } finally {
    clearTimeout(timer);
  }
}

export async function getDecision(
  signals: SignalResult[],
  snap: MarketSnapshot,
  cfg: Config,
  log: (msg: string, extra?: unknown) => void,
): Promise<Decision> {
  if (!cfg.features.ai) return majorityVote(signals, snap, cfg);
  return getLlmDecision(signals, snap, cfg, log);
}
