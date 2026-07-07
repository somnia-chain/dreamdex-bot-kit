/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Runnable entry point for the TWAP executor. Fires one slice per interval until
// the schedule is complete, then exits. Ctrl-C stops early and prints progress.

import { createChainContext, Pool } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { Twap } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[twap ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, config.symbol);
  log(
    `network=${ctx.net.name} ${config.side} $${config.totalUsdso} of ${config.symbol} ` +
      `in ${config.slices} slices every ${config.intervalSec}s (maxSlippage ${config.maxSlippageBps}bps) dryRun=${config.dryRun}`,
  );

  const twap = new Twap(pool, config, log);

  let stop = false;
  process.on("SIGINT", () => { stop = true; log("stopping early…"); });
  process.on("SIGTERM", () => { stop = true; });

  // Fire the first slice immediately, then one per interval.
  while (!stop && !twap.done) {
    try {
      await twap.slice();
    } catch (err) {
      log("slice error", (err as Error).message);
    }
    if (twap.done) break;
    await sleep(config.intervalSec * 1000);
  }

  log(`done — ${twap.summary()}`);
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[twap] fatal:", err);
  process.exit(1);
});
