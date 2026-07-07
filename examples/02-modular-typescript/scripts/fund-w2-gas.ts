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
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; privateKey: string; role: string }>;
  };
  const target = fleet.wallets[Number(process.argv[2] ?? "2")];
  if (!target) throw new Error("Wallet not found");
  const reg = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const amount = ethers.parseEther(process.argv[3] ?? "0.02");
  logger.info({ to: target.address, amount: ethers.formatEther(amount) }, "Funding gas");
  const tx = await reg.sendTransaction({ to: target.address, value: amount });
  await tx.wait();
  logger.info({ tx: tx.hash }, "Funded");
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
