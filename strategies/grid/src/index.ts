/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Runnable entry point for the grid bot. Interval-driven: reads top of book each
// tick and acts on triggers. Grid logic is stateful (FIFO lots), so we run one
// tick at a time and never overlap.

import { createChainContext, Pool } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { Grid } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[grid ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, config.symbol);
  log(`network=${ctx.net.name} market=${config.symbol} step=${config.stepBps}bps lot=$${config.lotUsdso} dryRun=${config.dryRun}`);

  const grid = new Grid(pool, config, log);

  let stop = false;
  process.on("SIGINT", () => { stop = true; log("stopping after current tick…"); });
  process.on("SIGTERM", () => { stop = true; });

  while (!stop) {
    try {
      await grid.tick();
    } catch (err) {
      log("tick error", (err as Error).message);
    }
    await sleep(config.intervalMs);
  }
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[grid] fatal:", err);
  process.exit(1);
});
