/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Debug helper: list + cancel any open orders on a market (cleanup), and decode
// the revert reason for a given tx hash.  NETWORK + SYMBOL + TXHASH via env.
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const core = await import("@dreamdex-bot-kit/core");
const { createChainContext, Pool, SPOT_POOL_ABI } = core;

async function main() {
  const ctx = createChainContext();
  const symbol = process.env.SYMBOL ?? "SOMI:USDso";
  const pool = await Pool.load(ctx, symbol);

  const ids = await pool.openOrderIds();
  console.log(`open orders on ${symbol}: ${ids.length ? ids.map(String).join(", ") : "none"}`);
  for (const id of ids) {
    try {
      const tx = await pool.cancel(id);
      console.log(`  cancelled ${id} tx=${tx}`);
    } catch (e) {
      console.log(`  cancel ${id} failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const txh = process.env.TXHASH as `0x${string}` | undefined;
  if (txh) {
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: txh });
    const tx = await ctx.publicClient.getTransaction({ hash: txh });
    console.log(`\ntx ${txh} status=${receipt.status} gasUsed=${receipt.gasUsed}`);
    try {
      // Replay the exact call at the mined block to surface the revert reason.
      await ctx.publicClient.call({ account: tx.from, to: tx.to!, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber });
      console.log("replay did NOT revert (state-dependent revert)");
    } catch (e) {
      console.log("revert reason:", (e as Error).message.split("\n").slice(0, 4).join(" | "));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
