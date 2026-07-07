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
import { getPool } from "../src/config/pairs.js";
import { logger } from "../src/utils/logger.js";

const SOMI_TO_SEND = process.argv[2] ?? "2";
const W3_INDEX = Number(process.argv[3] ?? "3");

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; privateKey: string; role: string }>;
  };
  const w3 = fleet.wallets[W3_INDEX];
  if (!w3) throw new Error("W3 not found");
  const reg = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const w3Wallet = new ethers.Wallet(w3.privateKey, provider);

  const amount = ethers.parseEther(SOMI_TO_SEND);
  logger.info({ from: reg.address, to: w3.address, amount: SOMI_TO_SEND }, "Sending native SOMI to W3");
  const tx1 = await reg.sendTransaction({ to: w3.address, value: amount });
  await tx1.wait();
  logger.info({ txHash: tx1.hash }, "Sent");

  // W3 deposit native to SOMI:USDso pool vault
  const pool = getPool(net.name, "SOMI:USDso");
  const pc = new ethers.Contract(
    pool.poolAddress,
    ["function depositNative() payable"],
    w3Wallet,
  );
  logger.info({ poolAddress: pool.poolAddress, amount: SOMI_TO_SEND }, "W3 depositNative to SOMI:USDso vault");
  const tx2 = await (pc.depositNative as ethers.BaseContractMethod<
    [],
    void,
    ethers.ContractTransactionResponse
  >)({ value: amount });
  await tx2.wait();
  logger.info({ txHash: tx2.hash }, "Deposit confirmed");
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
