/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { logger } from "../src/utils/logger.js";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle, getErc20 } from "../src/dex/contracts.js";
import { toRaw, fromRaw } from "../src/utils/decimals.js";

const POOL_SYMBOL = process.argv[2] ?? "SOMI:USDso";
const QUOTE_AMOUNT = process.argv[3] ?? "2";
const BASE_AMOUNT = process.argv[4] ?? "0";

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const handle = await getPoolHandle(POOL_SYMBOL);
  logger.info(
    {
      pool: handle.pool.symbol,
      poolAddress: handle.pool.poolAddress,
      base: handle.baseToken.symbol,
      quote: handle.quoteToken.symbol,
    },
    "Targeting pool",
  );

  const quoteAmountRaw = toRaw(QUOTE_AMOUNT, handle.quoteToken.decimals);
  const baseAmountRaw = toRaw(BASE_AMOUNT, handle.baseToken.decimals);

  if (quoteAmountRaw > 0n) {
    await depositErc20(
      handle.pool.poolAddress,
      handle.quoteToken.address,
      handle.quoteToken.symbol,
      handle.quoteToken.decimals,
      quoteAmountRaw,
    );
  }

  if (baseAmountRaw > 0n) {
    if (handle.baseToken.isNative) {
      await depositNative(handle.pool.poolAddress, baseAmountRaw);
    } else {
      await depositErc20(
        handle.pool.poolAddress,
        handle.baseToken.address,
        handle.baseToken.symbol,
        handle.baseToken.decimals,
        baseAmountRaw,
      );
    }
  }

  logger.info("Deposit script finished");
}

async function depositErc20(
  pool: string,
  tokenAddress: string,
  symbol: string,
  decimals: number,
  amount: bigint,
): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const erc20 = await getErc20(tokenAddress);
  const allowance = await erc20.allowance(ctx.wallet.address, pool);
  logger.info(
    {
      symbol,
      amount: fromRaw(amount, decimals),
      currentAllowance: fromRaw(allowance, decimals),
    },
    "Checking allowance",
  );

  if (allowance < amount) {
    logger.info({ symbol, amount: fromRaw(amount, decimals) }, "Approving token");
    const approveTx = await erc20.approve(pool, amount);
    const approveReceipt = await approveTx.wait();
    logger.info(
      { symbol, txHash: approveReceipt?.hash },
      "Approval confirmed",
    );
  }

  const poolContract = new ethers.Contract(
    pool,
    ["function deposit(address token, uint256 amount)"],
    ctx.wallet,
  );
  logger.info({ symbol, amount: fromRaw(amount, decimals) }, "Calling pool.deposit");
  const tx = await (poolContract.deposit as ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >)(tokenAddress, amount);
  const receipt = await tx.wait();
  logger.info({ symbol, txHash: receipt?.hash }, "Deposit confirmed");
}

async function depositNative(pool: string, amount: bigint): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const poolContract = new ethers.Contract(
    pool,
    ["function depositNative() payable"],
    ctx.wallet,
  );
  logger.info(
    { amount: ethers.formatEther(amount), pool },
    "Calling pool.depositNative",
  );
  const tx = await (poolContract.depositNative as ethers.BaseContractMethod<
    [],
    void,
    ethers.ContractTransactionResponse
  >)({ value: amount });
  const receipt = await tx.wait();
  logger.info({ txHash: receipt?.hash }, "depositNative confirmed");
}

main().catch((err) => {
  logger.fatal({ err }, "deposit-vault crashed");
  process.exit(1);
});
