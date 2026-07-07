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

interface BotWallet {
  id: number;
  address: string;
  privateKey: string;
  role: string;
}

const FROM_INDICES = (process.argv[2] ?? "0,1,2,3,4").split(",").map(Number);
const TARGET = process.argv[3] ?? "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86";
const KEEP_BUFFER = process.argv[4] ?? "0.02";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as { wallets: BotWallet[] };
  const keepWei = ethers.parseEther(KEEP_BUFFER);

  let totalSent = 0n;
  for (const idx of FROM_INDICES) {
    const w = fleet.wallets[idx];
    if (!w) continue;
    const signer = new ethers.Wallet(w.privateKey, provider);
    const bal = await provider.getBalance(w.address);
    if (bal <= keepWei) {
      logger.info({ id: idx, balance: ethers.formatEther(bal) }, "Skipping (insufficient)");
      continue;
    }
    const sendAmount = bal - keepWei - ethers.parseEther("0.001"); // also reserve for gas of this tx
    if (sendAmount <= 0n) continue;
    logger.info({ id: idx, sendAmount: ethers.formatEther(sendAmount), from: w.address }, "Sending native");
    const tx = await signer.sendTransaction({ to: TARGET, value: sendAmount });
    await tx.wait();
    totalSent += sendAmount;
    logger.info({ id: idx, txHash: tx.hash }, "Sent");
  }
  logger.info({ totalSent: ethers.formatEther(totalSent), to: TARGET }, "Consolidation complete");
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
