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

async function main(): Promise<void> {
  const TX = process.argv[2];
  if (!TX) throw new Error("Usage: tsx scripts/dump-tx-topics.ts <txHash>");

  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const r = await provider.getTransactionReceipt(TX);
  if (!r) throw new Error("no receipt");
  console.log(`tx: ${TX}`);
  console.log(`status: ${r.status}  gas: ${r.gasUsed.toString()}  logs: ${r.logs.length}`);
  r.logs.forEach((l, i) => {
    console.log(`--- log ${i} addr: ${l.address}`);
    l.topics.forEach((t, j) => console.log(`  topic${j}: ${t}`));
    console.log(`  data (${l.data.length} hex chars): ${l.data.slice(0, 200)}${l.data.length > 200 ? "..." : ""}`);
  });
  const tx = await provider.getTransaction(TX);
  console.log(`=== METHOD CALL ===`);
  console.log(`to: ${tx?.to}`);
  console.log(`from: ${tx?.from}`);
  console.log(`selector: ${tx?.data.slice(0, 10)}`);
  console.log(`calldata len: ${tx?.data.length} chars`);
}
main().catch((e) => { console.error(e); process.exit(1); });
