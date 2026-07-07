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
import { logger } from "../src/utils/logger.js";

const PROBE_ABI = ["function getWithdrawableBalance(address account, address token) view returns (uint256)"];

type GetWithdrawableBalance = ethers.BaseContractMethod<[string, string], bigint, bigint>;

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });

  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; role: string }>;
  };
  const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86";

  const allAddrs = [
    { label: "Reg", address: REG },
    ...fleet.wallets.map((w) => ({ label: `W${w.id} (${w.role})`, address: w.address })),
  ];

  const usdso = getToken(net.name, "USDso");
  const somi = getToken(net.name, "SOMI");

  console.log("=".repeat(110));
  console.log("Vault balances per wallet per pool (mainnet)");
  console.log("=".repeat(110));

  for (const poolSym of Object.keys(POOLS[net.name])) {
    const pool = POOLS[net.name][poolSym]!;
    const c = new ethers.Contract(pool.poolAddress, PROBE_ABI, provider);
    const getWithdrawableBalance = c.getWithdrawableBalance as GetWithdrawableBalance;

    console.log(`\n📦 ${poolSym} (${pool.poolAddress})`);
    console.log("-".repeat(110));

    for (const a of allAddrs) {
      try {
        const usdsoBal = await getWithdrawableBalance(a.address, usdso.address);
        const somiBal = await getWithdrawableBalance(a.address, somi.address);
        if (usdsoBal > 0n || somiBal > 0n) {
          console.log(
            `  ${a.label.padEnd(25)} USDso: ${ethers.formatUnits(usdsoBal, 18).padStart(12)}  |  SOMI: ${ethers.formatUnits(somiBal, 18).padStart(12)}`,
          );
        }
      } catch (err) {
        // skip silently — some pools/tokens may not be relevant
      }
    }
  }
  console.log("\n" + "=".repeat(110));
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
