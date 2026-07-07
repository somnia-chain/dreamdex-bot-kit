/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Runnable entry point for the momentum bot. Interval-driven: each tick samples
// the mid and evaluates entry/exit. On shutdown it flattens any open position.

import { createChainContext, Pool } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { Momentum } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[momentum ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, config.symbol);
  log(`network=${ctx.net.name} market=${config.symbol} window=${config.windowSize} dryRun=${config.dryRun}`);

  const mom = new Momentum(pool, config, log);

  let stop = false;
  const shutdown = async () => {
    stop = true;
    log("flattening and exiting…");
    await mom.flatten();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stop) {
    try {
      await mom.tick();
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
  console.error("[momentum] fatal:", err);
  process.exit(1);
});
