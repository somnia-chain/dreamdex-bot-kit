/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Runnable entry point: connect, quote, and keep quoting until Ctrl-C.
//
// Full flow in one file (auth is lazy — the REST client signs in on first use;
// here we only need on-chain reads + writes, which the ChainContext covers):
//   load market → subscribe to the book over WS → requote on updates (with an
//   interval fallback) → cancel everything cleanly on shutdown.

import { createChainContext, Pool, DreamDexWs } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { MarketMaker } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[mm ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  log(`network=${ctx.net.name} wallet=${ctx.account.address} dryRun=${config.dryRun}`);

  const pool = await Pool.load(ctx, config.symbol);
  log(`market ${config.symbol} tick=${pool.tick} lot=${pool.lot} minQty=${pool.minQty}`);

  const mm = new MarketMaker(pool, config, log);

  // WS-driven requoting, with a poll-interval fallback for quiet books.
  const ws = new DreamDexWs(
    ctx.net,
    (msg) => {
      if (msg.channel === "orderbook") mm.onBook().catch((e) => log("onBook error", (e as Error).message));
    },
    () => log("ws connected — subscriptions (re)sent"),
  );
  ws.connect();
  ws.subscribeOrderbook([config.symbol]);

  const interval = setInterval(() => {
    mm.onBook().catch((e) => log("tick error", (e as Error).message));
  }, config.refreshIntervalMs);

  // Quote immediately, don't wait for the first WS message.
  await mm.onBook();

  const shutdown = async () => {
    log("shutting down — cancelling open quotes…");
    clearInterval(interval);
    ws.close();
    await mm.cancelAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mm] fatal:", err);
  process.exit(1);
});
