/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { getActiveNetwork } from "../src/config/network.js";
import { getToken } from "../src/config/tokens.js";
import { POOLS } from "../src/config/pairs.js";

// COMPLIANCE CHECK: scan every USDso transfer INTO the registered wallet and
// group by sender. Confirms no external USDso top-up beyond the initial 50
// allocation (competition rule: adding >50 USDso = disqualification).
//
// Usage: tsx scripts/verify-usdso-inflows.ts [blockLookback=400000]

const LOOKBACK = Number(process.argv[2] ?? "400000");
const CHUNK = 999;
const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86".toLowerCase();
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const usdso = getToken(net.name, "USDso");

  // Build label map of known internal addresses
  const labels = new Map<string, string>();
  for (const sym of Object.keys(POOLS[net.name])) {
    labels.set(POOLS[net.name][sym]!.poolAddress.toLowerCase(), `POOL ${sym}`);
  }
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; role: string }>;
  };
  for (const w of fleet.wallets) {
    labels.set(w.address.toLowerCase(), `FLEET W${w.id} (${w.role})`);
  }

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK);
  console.log(`Scanning USDso transfers INTO ${REG}`);
  console.log(`Blocks ${fromBlock}..${latest} (~${LOOKBACK})`);
  console.log("=".repeat(90));

  const regTopic = ethers.zeroPadValue(REG, 32);
  const bySender = new Map<string, { total: bigint; count: number }>();

  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    try {
      const logs = await provider.getLogs({
        address: usdso.address,
        fromBlock: start,
        toBlock: end,
        topics: [TRANSFER_TOPIC, null, regTopic], // to = Reg
      });
      for (const l of logs) {
        const sender = ("0x" + l.topics[1]!.slice(26)).toLowerCase();
        const amount = BigInt(l.data);
        const cur = bySender.get(sender) ?? { total: 0n, count: 0 };
        cur.total += amount;
        cur.count += 1;
        bySender.set(sender, cur);
      }
    } catch (err) {
      console.error(`  getLogs ${start}-${end} failed: ${(err as Error).message}`);
    }
  }

  let internalTotal = 0n;
  let externalTotal = 0n;
  const externalSenders: Array<{ addr: string; total: bigint; count: number }> = [];

  console.log("\nUSDso inflows grouped by sender:\n");
  const sorted = [...bySender.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1));
  for (const [sender, info] of sorted) {
    const label = labels.get(sender);
    const amt = ethers.formatUnits(info.total, usdso.decimals);
    if (label) {
      internalTotal += info.total;
      console.log(`  [INTERNAL] ${label.padEnd(28)} ${amt.padStart(14)} USDso  (${info.count} tx)  from ${sender}`);
    } else {
      externalTotal += info.total;
      externalSenders.push({ addr: sender, total: info.total, count: info.count });
      console.log(`  [EXTERNAL] ${"?".padEnd(28)} ${amt.padStart(14)} USDso  (${info.count} tx)  from ${sender}`);
    }
  }

  console.log("\n" + "=".repeat(90));
  console.log(`Total INTERNAL inflows (own pools/fleet): ${ethers.formatUnits(internalTotal, usdso.decimals)} USDso`);
  console.log(`Total EXTERNAL inflows:                   ${ethers.formatUnits(externalTotal, usdso.decimals)} USDso`);
  console.log("=".repeat(90));
  console.log("\nCOMPLIANCE READING:");
  console.log("- INTERNAL = USDso circulating among our own wallets/pools (not new capital)");
  console.log("- EXTERNAL = USDso entering from outside. Should equal ONLY the competition's");
  console.log("  initial 50 allocation (from one distributor address). Anything beyond 50 from");
  console.log("  external sources would be a rule violation.");
  if (externalSenders.length === 1) {
    const e = externalSenders[0]!;
    console.log(`\n=> Single external sender: ${ethers.formatUnits(e.total, usdso.decimals)} USDso from ${e.addr}`);
    console.log("   (Expected: the competition distributor sending the initial 50.)");
  } else {
    console.log(`\n=> ${externalSenders.length} external senders detected. Review each below to confirm legitimacy.`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
