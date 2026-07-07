/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Owner-side (fund key) helpers for split-key / session-key trading.
//
// The model: a cold FUND key holds the money and does one-time setup — opt into
// manual vault mode, deposit working capital, and grant a hot OPERATOR key the
// right to place/cancel orders. The operator key then runs the bot and can never
// move funds out (deposits/withdrawals/approvals are owner-scoped; fills settle
// to the owner). See docs/session-keys.md.
//
// These are called by the fund key (a ChainContext built from the fund key).

import type { PublicClient } from "viem";
import type { ChainContext } from "./client.js";
import { SPOT_POOL_ABI, ERC20_ABI, OPERATOR_REGISTRY_ABI, OPERATOR_SELECTOR } from "./contract.js";

type Selector = `0x${string}`;

async function send(ctx: ChainContext, hash: `0x${string}`): Promise<`0x${string}`> {
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Per pool: draw from / settle to the vault instead of the wallet (required for clean operator custody). */
export async function setManualVaultMode(ctx: ChainContext, pool: `0x${string}`, enabled: boolean): Promise<`0x${string}`> {
  return send(ctx, await ctx.walletClient.writeContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "setManualVaultMode", args: [enabled], account: ctx.account, chain: ctx.walletClient.chain }));
}

/** Approve + deposit working capital into a pool's vault (the operator trades against this). */
export async function depositVault(ctx: ChainContext, pool: `0x${string}`, token: `0x${string}`, amountRaw: bigint): Promise<`0x${string}`> {
  const allowance = await ctx.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [ctx.account.address, pool] });
  if (allowance < amountRaw) {
    await send(ctx, await ctx.walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [pool, amountRaw], account: ctx.account, chain: ctx.walletClient.chain }));
  }
  return send(ctx, await ctx.walletClient.writeContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "deposit", args: [token, amountRaw], account: ctx.account, chain: ctx.walletClient.chain }));
}

export async function withdrawVault(ctx: ChainContext, pool: `0x${string}`, token: `0x${string}`, amountRaw: bigint): Promise<`0x${string}`> {
  return send(ctx, await ctx.walletClient.writeContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "withdraw", args: [token, amountRaw], account: ctx.account, chain: ctx.walletClient.chain }));
}

/** Grant (or revoke) an operator for a single pool. Defaults to place + cancel. */
export async function grantOperator(
  ctx: ChainContext,
  pool: `0x${string}`,
  operator: `0x${string}`,
  selectors: readonly Selector[] = [OPERATOR_SELECTOR.placeOrderFor, OPERATOR_SELECTOR.cancelOrderFor],
  approved = true,
): Promise<`0x${string}`> {
  return send(ctx, await ctx.walletClient.writeContract({
    address: ctx.net.operatorRegistry, abi: OPERATOR_REGISTRY_ABI, functionName: "setOperatorApprovalForPool",
    args: [pool, operator, selectors as Selector[], approved], account: ctx.account, chain: ctx.walletClient.chain,
  }));
}

export function revokeOperator(ctx: ChainContext, pool: `0x${string}`, operator: `0x${string}`, selectors?: readonly Selector[]): Promise<`0x${string}`> {
  return grantOperator(ctx, pool, operator, selectors, false);
}

/** The exact yes/no the pool enforces inside placeOrderFor / cancelOrderFor. */
export async function isOperatorAuthorized(client: PublicClient, pool: `0x${string}`, owner: `0x${string}`, operator: `0x${string}`, selector: Selector): Promise<boolean> {
  return client.readContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "isOperatorAuthorized", args: [owner, operator, selector] });
}
