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
import { getToken } from "../src/config/tokens.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; privateKey: string; role: string }>;
  };
  const w3 = fleet.wallets[3];
  if (!w3) throw new Error("W3 not found");
  const w3Wallet = new ethers.Wallet(w3.privateKey, provider);

  const pool = getPool(net.name, "SOMI:USDso");
  const somiTok = getToken(net.name, "SOMI");
  const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86";

  const poolC = new ethers.Contract(
    pool.poolAddress,
    [
      "function getWithdrawableBalance(address account, address token) view returns (uint256)",
      "function withdraw(address token, uint256 amount)",
    ],
    w3Wallet,
  );

  const before: bigint = await (poolC.getWithdrawableBalance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(w3.address, somiTok.address);
  logger.info({ vaultSomi: ethers.formatEther(before) }, "W3 vault SOMI before withdraw");

  if (before <= 0n) {
    logger.warn("Nothing to withdraw");
    return;
  }

  logger.info({ amount: ethers.formatEther(before) }, "Withdrawing SOMI from vault to W3 wallet");
  const tx1 = await (poolC.withdraw as ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >)(somiTok.address, before);
  await tx1.wait();
  logger.info({ tx: tx1.hash }, "Withdrew");

  // Now W3 wallet has the SOMI as native. Send to Reg minus gas reserve.
  const w3Native = await provider.getBalance(w3.address);
  const keepBuffer = ethers.parseEther("0.01");
  if (w3Native <= keepBuffer) {
    logger.warn("W3 wallet too low to send");
    return;
  }
  const sendAmount = w3Native - keepBuffer - ethers.parseEther("0.001"); // tx gas reserve

  logger.info({ amount: ethers.formatEther(sendAmount) }, "Sending native SOMI from W3 → Registered");
  const tx2 = await w3Wallet.sendTransaction({ to: REG, value: sendAmount });
  await tx2.wait();
  logger.info({ tx: tx2.hash }, "Transfer complete");
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
