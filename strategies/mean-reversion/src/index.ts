/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Runnable entry point for the mean-reversion bot. Interval-driven; flattens any
// open position on shutdown.

import { createChainContext, Pool } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { MeanReversion } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[mean-reversion ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, config.symbol);
  log(`network=${ctx.net.name} market=${config.symbol} rsiPeriod=${config.rsiPeriod} dryRun=${config.dryRun}`);

  const mr = new MeanReversion(pool, config, log);

  let stop = false;
  const shutdown = async () => {
    stop = true;
    log("flattening and exiting…");
    await mr.flatten();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stop) {
    try {
      await mr.tick();
    } catch (err) {
      log("tick error", (err as Error).message);
    }
    await sleep(config.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[mean-reversion] fatal:", err);
  process.exit(1);
});
