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

const SOMI_AMOUNT = process.argv[2] ?? "7.0";
const W2_INDEX = Number(process.argv[3] ?? "2");

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const fleet = JSON.parse(await readFile("data/bot-wallets.json", "utf-8")) as {
    wallets: Array<{ id: number; address: string; privateKey: string; role: string }>;
  };
  const w2 = fleet.wallets[W2_INDEX];
  if (!w2) throw new Error(`Wallet index ${W2_INDEX} not found`);
  const w2Wallet = new ethers.Wallet(w2.privateKey, provider);

  const pool = getPool(net.name, "SOMI:USDso");
  const somiTok = getToken(net.name, "SOMI");
  const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86";

  const poolC = new ethers.Contract(
    pool.poolAddress,
    [
      "function getWithdrawableBalance(address account, address token) view returns (uint256)",
      "function withdraw(address token, uint256 amount)",
    ],
    w2Wallet,
  );

  const before: bigint = await (poolC.getWithdrawableBalance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(w2.address, somiTok.address);
  logger.info({ vaultSomi: ethers.formatEther(before), wallet: w2.address }, `W${W2_INDEX} vault SOMI before withdraw`);

  const amountToWithdraw = ethers.parseEther(SOMI_AMOUNT);
  if (before < amountToWithdraw) {
    throw new Error(`Vault has ${ethers.formatEther(before)} SOMI but trying to withdraw ${SOMI_AMOUNT}`);
  }

  logger.info({ amount: SOMI_AMOUNT }, "Withdrawing SOMI from W2's SOMI:USDso vault");
  const tx1 = await (poolC.withdraw as ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >)(somiTok.address, amountToWithdraw);
  await tx1.wait();
  logger.info({ tx: tx1.hash }, "Withdrew");

  const w2Native = await provider.getBalance(w2.address);
  const keepBuffer = ethers.parseEther("0.005");
  const sendAmount = w2Native - keepBuffer - ethers.parseEther("0.001");
  if (sendAmount <= 0n) {
    logger.warn("Not enough to send after gas buffer");
    return;
  }
  logger.info({ amount: ethers.formatEther(sendAmount), to: REG }, "Sending native SOMI W2 → Registered");
  const tx2 = await w2Wallet.sendTransaction({ to: REG, value: sendAmount });
  await tx2.wait();
  logger.info({ tx: tx2.hash }, "Transfer complete");

  const regNative = await provider.getBalance(REG);
  logger.info({ regNative: ethers.formatEther(regNative) }, "✅ Reg wallet native SOMI updated");
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
