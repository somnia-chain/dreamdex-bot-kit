/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { getActiveNetwork } from "../src/config/network.js";
import { POOLS } from "../src/config/pairs.js";
import { logger } from "../src/utils/logger.js";

const TARGET = (process.argv[2] ?? "").toLowerCase();
if (!TARGET || !ethers.isAddress(TARGET)) {
  throw new Error("Usage: tsx scripts/scan-wallet-txs.ts <address> [blockLookback=2000]");
}
const LOOKBACK = Number(process.argv[3] ?? "2000");

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });

  const target = ethers.getAddress(TARGET);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK);
  const targetLow = target.toLowerCase();

  const poolAddrs = new Set<string>();
  const poolNameByAddr = new Map<string, string>();
  for (const sym of Object.keys(POOLS[net.name])) {
    const a = POOLS[net.name][sym]!.poolAddress.toLowerCase();
    poolAddrs.add(a);
    poolNameByAddr.set(a, sym);
  }

  console.log(`Scanning blocks ${fromBlock} → ${latest} for txs from ${target}`);

  const toCount = new Map<string, number>();
  const methodCount = new Map<string, number>();
  const samples: Array<{ block: number; hash: string; to: string; method: string; value: string }> = [];

  for (let b = latest; b >= fromBlock; b--) {
    let block: ethers.Block | null;
    try {
      block = await provider.getBlock(b, true);
    } catch {
      continue;
    }
    if (!block) continue;
    for (const txOrHash of block.prefetchedTransactions ?? []) {
      const tx = txOrHash as ethers.TransactionResponse;
      if (tx.from?.toLowerCase() !== targetLow) continue;
      const to = tx.to?.toLowerCase() ?? "(create)";
      toCount.set(to, (toCount.get(to) ?? 0) + 1);
      const sel = tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : "(no data)";
      methodCount.set(sel, (methodCount.get(sel) ?? 0) + 1);
      if (samples.length < 30) {
        samples.push({
          block: b,
          hash: tx.hash,
          to,
          method: sel,
          value: ethers.formatEther(tx.value ?? 0n),
        });
      }
    }
  }

  console.log("\n=== Top 'to' destinations ===");
  for (const [addr, count] of [...toCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    const lbl = poolNameByAddr.get(addr) ?? "";
    console.log(`  ${count.toString().padStart(5)}  ${addr}  ${lbl}`);
  }

  console.log("\n=== Top method selectors ===");
  for (const [sel, count] of [...methodCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${count.toString().padStart(5)}  ${sel}`);
  }

  console.log("\n=== Sample TXs (latest 30) ===");
  for (const s of samples) {
    const lbl = poolNameByAddr.get(s.to) ?? "";
    console.log(`  blk=${s.block} ${s.hash}  to=${s.to.slice(0, 10)}…${lbl ? ` (${lbl})` : ""}  sel=${s.method}  val=${s.value}`);
  }
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
