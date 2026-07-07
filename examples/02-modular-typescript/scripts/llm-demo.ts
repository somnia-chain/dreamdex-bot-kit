/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { DecisionEngine, type MarketSnapshot, type BotMetrics } from "../src/llm/decision-engine.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const engine = new DecisionEngine(process.env.OLLAMA_MODEL ?? "llama3.2", process.env.OLLAMA_URL);

  logger.info("Checking Ollama health...");
  const healthy = await engine.isHealthy();
  if (!healthy) {
    logger.warn(
      "Ollama not running or model not pulled. To enable:\n" +
        "  1. Install Ollama from https://ollama.com\n" +
        "  2. Run: ollama serve  (in another terminal)\n" +
        "  3. Run: ollama pull llama3.2\n" +
        "  4. Re-run this script.\n" +
        "\n" +
        "For now, demo will run in stubbed-fallback mode.",
    );
  }

  const scenarios: Array<{ name: string; market: MarketSnapshot; metrics: BotMetrics }> = [
    {
      name: "Market quiet, low volume",
      market: {
        pool: "USDC.e:USDso",
        midPrice: 1.0,
        bookDepthBid: 0,
        bookDepthAsk: 0,
        recentVolume: 0,
        recentTrades: 0,
        driftBps5min: 0,
      },
      metrics: {
        totalVolumeUsdso: 2.5,
        totalTxCount: 13,
        leaderboardRank: 5,
        rolling60sFills: 0,
        rolling60sErrors: 4,
      },
    },
    {
      name: "Market very active, lots of takers",
      market: {
        pool: "WETH:USDso",
        midPrice: 3000,
        bookDepthBid: 12,
        bookDepthAsk: 11,
        recentVolume: 500,
        recentTrades: 80,
        driftBps5min: 12,
      },
      metrics: {
        totalVolumeUsdso: 1356,
        totalTxCount: 498,
        leaderboardRank: 1,
        rolling60sFills: 18,
        rolling60sErrors: 0,
      },
    },
    {
      name: "Volatility spike (60 bps drift in 5 min)",
      market: {
        pool: "SOMI:USDso",
        midPrice: 0.17,
        bookDepthBid: 4,
        bookDepthAsk: 4,
        recentVolume: 30,
        recentTrades: 12,
        driftBps5min: 65,
      },
      metrics: {
        totalVolumeUsdso: 947,
        totalTxCount: 398,
        leaderboardRank: 2,
        rolling60sFills: 6,
        rolling60sErrors: 2,
      },
    },
  ];

  for (const scen of scenarios) {
    logger.info({ scenario: scen.name }, "=== Asking LLM ===");
    const decision = await engine.decide(scen.market, scen.metrics);
    logger.info(
      {
        action: decision.action,
        spreadBps: decision.spreadBps,
        switchPair: decision.switchPair,
        pauseDurationMs: decision.pauseDurationMs,
        rationale: decision.rationale,
      },
      "Decision",
    );
  }
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message });
  process.exit(1);
});
