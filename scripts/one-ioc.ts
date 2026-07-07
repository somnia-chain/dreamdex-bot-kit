/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// One safe IOC order through the full lifecycle (estimate → sim → broadcast →
// verify), reporting gasUsed and the balance delta so we can see it filled.
// SIDE=buy|sell, SYMBOL, SIZE_USDSO via env.
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const { createChainContext, Pool, ORDER_TYPE } = await import("@dreamdex-bot-kit/core");

async function main() {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, process.env.SYMBOL ?? "USDC.e:USDso");
  const side = (process.env.SIDE ?? "buy") as "buy" | "sell";
  const sizeUsdso = Number(process.env.SIZE_USDSO ?? "1.5");
  const { bestBid, bestAsk } = await pool.topOfBook();
  if (bestBid === undefined || bestAsk === undefined) throw new Error("empty book");

  const isBid = side === "buy";
  const touch = isBid ? bestAsk : bestBid;
  const price = isBid ? touch * 1.001 : touch * 0.999; // cross by 10 bps
  const qty = sizeUsdso / touch;

  // Read the WALLET balance: in the default auto-pull/auto-deliver mode fills
  // settle to the wallet, so vaultBase() stays ~0 and would print Δ 0 on a fill.
  const baseBefore = await pool.walletBase();
  console.log(`placing IOC ${side} ${qty.toFixed(4)} @ ~${touch} (cross to ${price.toFixed(6)})`);
  const res = await pool.place({ isBid, price, qty, orderType: ORDER_TYPE.ImmediateOrCancel });
  console.log(`  txHash=${res.txHash}`);
  console.log(`  orderId=${res.orderId}`);
  console.log(`  gasUsed=${res.gasUsed}`);
  const baseAfter = await pool.walletBase();
  console.log(`  walletBase ${baseBefore} → ${baseAfter} (Δ ${(baseAfter - baseBefore).toFixed(6)})`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
