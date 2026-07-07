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
import { TOKENS } from "../src/config/tokens.js";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const p = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86";
  const erc20 = ["function balanceOf(address) view returns (uint256)"];

  console.log(`Registered wallet ${REG} — all token balances (mainnet)`);
  console.log("-".repeat(60));

  for (const sym of ["WETH", "WBTC", "USDC.e", "USDso"]) {
    const t = TOKENS[net.name][sym];
    if (!t) continue;
    const c = new ethers.Contract(t.address, erc20, p);
    const bal = (await c.balanceOf!(REG)) as bigint;
    console.log(`${sym.padEnd(8)}: ${ethers.formatUnits(bal, t.decimals)}`);
  }
  const native = await p.getBalance(REG);
  console.log(`SOMI    : ${ethers.formatEther(native)}  (native)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
