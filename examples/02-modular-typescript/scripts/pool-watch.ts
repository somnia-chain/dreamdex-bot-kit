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

const POLL_INTERVAL_MS = Number(process.argv[2] ?? "60000");

const PROBE_ABI = ["function getBookLevels(bool isBid, uint8 depth) view returns (uint256[] prices, uint256[] sizes)"];

type GetBookLevels = ethers.BaseContractMethod<[boolean, number], [bigint[], bigint[]], [bigint[], bigint[]]>;

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });

  logger.info({ interval: POLL_INTERVAL_MS / 1000 + "s" }, "Pool watcher armed");

  while (true) {
    const ts = new Date().toISOString();
    let anyWoke = false;
    for (const sym of Object.keys(POOLS[net.name])) {
      const pool = POOLS[net.name][sym]!;
      const c = new ethers.Contract(pool.poolAddress, PROBE_ABI, provider);
      let bidOk = false;
      let askOk = false;
      const getBookLevels = c.getBookLevels as GetBookLevels;
      try {
        await getBookLevels(true, 1);
        bidOk = true;
      } catch { /* empty */ }
      try {
        await getBookLevels(false, 1);
        askOk = true;
      } catch { /* empty */ }
      if (bidOk || askOk) {
        process.stdout.write(`POOL ALIVE ${ts} ${sym}: bid=${bidOk} ask=${askOk}\n`);
        anyWoke = true;
      }
    }
    if (!anyWoke) {
      process.stdout.write(`[${ts}] all 4 pools still dry\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
