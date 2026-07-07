/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { logger } from "../utils/logger.js";
import { OllamaClient } from "./ollama-client.js";

export interface MarketSnapshot {
  pool: string;
  midPrice: number | null;
  bookDepthBid: number;
  bookDepthAsk: number;
  recentVolume: number;
  recentTrades: number;
  driftBps5min: number | null;
}

export interface BotMetrics {
  totalVolumeUsdso: number;
  totalTxCount: number;
  leaderboardRank: number | null;
  rolling60sFills: number;
  rolling60sErrors: number;
}

export interface StrategyDecision {
  action: "continue" | "pause" | "widen_spread" | "tighten_spread" | "switch_pair" | "stop";
  spreadBps?: number;
  switchPair?: string;
  pauseDurationMs?: number;
  rationale: string;
}

const SYSTEM_PROMPT = `You are the meta-decision layer for an automated market-making bot trading on DreamDEX (Somnia blockchain alpha competition). Your job: pick exactly ONE action per call, based on the inputs.

Goal priority:
1. Maximize trading volume (primary KPI)
2. Avoid catastrophic PnL loss (USDso balance must end >= 40)
3. Generate diverse strategy signals (judging score values "effort + tactics")

Allowed actions:
- "continue"          — keep current strategy, current spread
- "pause"             — stop trading for N ms (rate limit cooldown)
- "widen_spread"      — increase spread bps if market volatile
- "tighten_spread"    — decrease spread bps if market quiet (more fills)
- "switch_pair"       — switch to a different pool symbol
- "stop"              — emergency: halt all activity

Output STRICT JSON, no prose, matching schema:
{ "action": "...", "spreadBps": <int optional>, "switchPair": "<symbol optional>", "pauseDurationMs": <int optional>, "rationale": "<short reason>" }
`;

export class DecisionEngine {
  private readonly client: OllamaClient;
  private healthy = false;
  private lastCheckMs = 0;
  private readonly healthIntervalMs = 60_000;

  constructor(private readonly model: string = "llama3.2", baseUrl?: string) {
    this.client = new OllamaClient({ model, baseUrl });
  }

  async isHealthy(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastCheckMs < this.healthIntervalMs && this.healthy) return true;
    const res = await this.client.healthCheck();
    this.healthy = res.ok;
    this.lastCheckMs = now;
    if (!res.ok) {
      logger.warn({ reason: res.reason }, "Ollama unhealthy, will retry in 60s");
    }
    return res.ok;
  }

  async decide(market: MarketSnapshot, metrics: BotMetrics): Promise<StrategyDecision> {
    if (!(await this.isHealthy())) {
      return {
        action: "continue",
        rationale: "Ollama unavailable; conservative default",
      };
    }

    const prompt =
      SYSTEM_PROMPT +
      "\n\nCurrent market snapshot:\n" +
      JSON.stringify(market, null, 2) +
      "\n\nCurrent bot metrics:\n" +
      JSON.stringify(metrics, null, 2) +
      "\n\nDecide:";

    try {
      const decision = await this.client.generateJson<StrategyDecision>(prompt, { temperature: 0.2 });
      logger.info(
        {
          action: decision.action,
          rationale: decision.rationale,
          spreadBps: decision.spreadBps,
          model: this.model,
        },
        "LLM meta-decision",
      );
      return decision;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "LLM decision failed, falling back to continue");
      return {
        action: "continue",
        rationale: `Fallback (LLM error: ${(err as Error).message.slice(0, 80)})`,
      };
    }
  }
}
