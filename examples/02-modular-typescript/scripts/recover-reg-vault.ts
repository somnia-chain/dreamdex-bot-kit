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
import { getPool } from "../src/config/pairs.js";
import { getToken } from "../src/config/tokens.js";
import { logger } from "../src/utils/logger.js";

// Withdraw the registered wallet's idle USDso (or specified token) from a pool
// vault back into the wallet. Improves leaderboard PnL (formula sees wallet USDso
// only) and frees capital for IOC BUY fuel.
//
// Usage: tsx scripts/recover-reg-vault.ts [poolSymbol=USDC.e:USDso] [tokenSym=USDso]
//
// SAFETY: do NOT run while an IOC loop is broadcasting from the Reg wallet —
// nonce collision. Run only in the gap between batches.

const POOL_SYMBOL = process.argv[2] ?? "USDC.e:USDso";
const TOKEN_SYM = process.argv[3] ?? "USDso";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const pool = getPool(net.name, POOL_SYMBOL);
  const tok = getToken(net.name, TOKEN_SYM);

  const poolC = new ethers.Contract(
    pool.poolAddress,
    [
      "function getWithdrawableBalance(address account, address token) view returns (uint256)",
      "function withdraw(address token, uint256 amount)",
    ],
    wallet,
  );
  const erc = new ethers.Contract(tok.address, ["function balanceOf(address) view returns (uint256)"], provider);

  const walletBefore = (await erc.balanceOf!(wallet.address)) as bigint;
  const vaultBal = (await (poolC.getWithdrawableBalance as ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >)(wallet.address, tok.address));

  logger.info(
    {
      pool: POOL_SYMBOL,
      token: TOKEN_SYM,
      walletBefore: ethers.formatUnits(walletBefore, tok.decimals),
      vaultBalance: ethers.formatUnits(vaultBal, tok.decimals),
    },
    "Reg vault recovery — before",
  );

  if (vaultBal <= 0n) {
    logger.warn("Nothing to withdraw from vault");
    return;
  }

  const tx = await (poolC.withdraw as ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >)(tok.address, vaultBal);
  logger.info({ tx: tx.hash }, "Withdraw broadcast");
  await tx.wait();

  const walletAfter = (await erc.balanceOf!(wallet.address)) as bigint;
  logger.info(
    {
      tx: tx.hash,
      walletAfter: ethers.formatUnits(walletAfter, tok.decimals),
      recovered: ethers.formatUnits(walletAfter - walletBefore, tok.decimals),
    },
    "✅ Reg vault recovery complete",
  );
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
