/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// The starter harness. You should NOT need to edit this file — it wires up the
// bot and calls decide() from strategy.ts each tick. It:
//   connect → every tick: read the book + your inventory → decide() → cancel old
//   orders and place the new ones (or just log them in dry-run) → cancel on exit.
//
// It cancels and re-places every tick for simplicity. That's fine to learn with,
// but it spends gas; ../market-making shows how to requote only when the price
// actually moves. Keep DRY_RUN=true until you're happy with what it logs.

import { createChainContext, Pool, ORDER_TYPE } from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { decide, type Snapshot } from "./strategy.js";

function log(msg: string, extra?: unknown): void {
  const line = `[starter ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  log(`network=${ctx.net.name} wallet=${ctx.account.address} dryRun=${config.dryRun}`);

  const pool = await Pool.load(ctx, config.symbol);
  log(`market ${config.symbol} tick=${pool.tick} lot=${pool.lot} minQty=${pool.minQty}`);

  let openIds: bigint[] = [];

  async function tick(): Promise<void> {
    const { bestBid, bestAsk, mid } = await pool.topOfBook();
    if (mid === undefined) {
      log("empty book — nothing to quote this tick");
      return;
    }
    const baseInventory = await pool.walletBase();
    const snap: Snapshot = { symbol: config.symbol, bestBid, bestAsk, mid, baseInventory };

    const quotes = decide(snap, config);

    if (config.dryRun) {
      for (const q of quotes) {
        log(`[dry-run] would ${q.side} ${q.size.toFixed(6)} @ ${q.price.toFixed(6)}${q.postOnly === false ? "" : " (postOnly)"}`);
      }
      return;
    }

    // Live: pull last tick's quotes, then place the fresh set.
    for (const id of openIds) {
      try { await pool.cancel(id); } catch (e) { log("cancel failed", (e as Error).message); }
    }
    openIds = [];
    for (const q of quotes) {
      try {
        const res = await pool.place({
          isBid: q.side === "buy",
          price: q.price,
          qty: q.size,
          orderType: q.postOnly === false ? ORDER_TYPE.ImmediateOrCancel : ORDER_TYPE.PostOnly,
          expireMs: config.expireMs,
        });
        if (res.orderId) openIds.push(res.orderId);
        log(`placed ${q.side} ${q.size.toFixed(6)} @ ${q.price.toFixed(6)} id=${res.orderId} tx=${res.txHash}`);
      } catch (e) {
        log(`place ${q.side} failed`, (e as Error).message);
      }
    }
  }

  const interval = setInterval(() => {
    tick().catch((e) => log("tick error", (e as Error).message));
  }, config.tickMs);
  await tick(); // quote immediately

  const shutdown = async () => {
    log("shutting down — cancelling open orders…");
    clearInterval(interval);
    for (const id of openIds) {
      try { await pool.cancel(id); } catch { /* best-effort */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error(`[starter] fatal: ${(e as Error).message}`); process.exit(1); });
