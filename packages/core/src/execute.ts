/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Order execution — the modern `placeOrder` path, done safely.
//
// The lifecycle every order should follow:
//   1. Guard inputs (expiry / price / builder / lot / min / tick).
//   2. Work out funding: getAutoPullRequirement() tells you the exact input
//      token + amount the pool will pull from your wallet. Native input goes in
//      msg.value; ERC-20 input needs an allowance to the pool.
//   3. Simulate (eth_call). placeOrder returns (success, orderId); if success is
//      false, DON'T broadcast — it would mine and do nothing.
//   4. Broadcast, wait for the receipt, and confirm an OrderPlaced log is
//      present (an empty log set = a silent rejection).
//   5. Read the real orderId from the receipt, NOT from the simulation — ids can
//      drift between sim and inclusion.

import type { Account, PublicClient, WalletClient } from "viem";
import { zeroAddress } from "viem";
import { SPOT_POOL_ABI, ERC20_ABI, TOPIC } from "./contract.js";
import { NATIVE_SENTINEL } from "./config/tokens.js";
import {
  ORDER_TYPE,
  SELF_MATCH,
  assertExpireNs,
  assertPriceRawNonZero,
  assertBuilderDisabled,
  assertQtyAboveMin,
  assertQtyMultipleOfLot,
  assertPriceMultipleOfTick,
  GotchaError,
} from "./gotchas.js";

/** Native-base BUYs deliver native SOMI to the buyer; that payout path needs a
 *  big gas headroom or it reverts with InsufficientGasForPayout. */
export const NATIVE_BASE_BUY_GAS = 5_000_000n;
const DEFAULT_GAS_FLOOR = 700_000n;

export interface PlaceOrderParams {
  pool: `0x${string}`;
  baseIsNative: boolean;
  isBid: boolean;
  priceRaw: bigint;
  quantityRaw: bigint;
  tickRaw: bigint;
  lotRaw: bigint;
  minQtyRaw: bigint;
  orderType?: number; // defaults to IOC
  expireTimestampNs: bigint;
  userData?: bigint;
}

export interface PlaceOrderResult {
  txHash: `0x${string}`;
  orderId: bigint | null;
  gasUsed: bigint;
}

export interface ExecCtx {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

export async function placeOrder(ctx: ExecCtx, p: PlaceOrderParams): Promise<PlaceOrderResult> {
  const orderType = p.orderType ?? ORDER_TYPE.ImmediateOrCancel;

  // 1. Guards.
  assertExpireNs(p.expireTimestampNs);
  assertPriceRawNonZero(p.priceRaw);
  assertPriceMultipleOfTick(p.priceRaw, p.tickRaw);
  assertQtyAboveMin(p.quantityRaw, p.minQtyRaw);
  assertQtyMultipleOfLot(p.quantityRaw, p.lotRaw);
  assertBuilderDisabled(zeroAddress, 0n);

  const args = [
    p.isBid,
    p.userData ?? 0n,
    p.priceRaw,
    p.quantityRaw,
    p.expireTimestampNs,
    orderType,
    SELF_MATCH.CancelTaker,
    zeroAddress,
    0n,
  ] as const;

  // 2. Funding: ask the pool exactly what it will pull.
  const [inputToken, requiredAmount] = await ctx.publicClient.readContract({
    address: p.pool,
    abi: SPOT_POOL_ABI,
    functionName: "getAutoPullRequirement",
    args: [ctx.account.address, p.isBid, p.priceRaw, p.quantityRaw, 0n],
  });

  let value = 0n;
  if (inputToken.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) {
    value = requiredAmount; // native input rides in msg.value
  } else {
    await ensureAllowance(ctx, inputToken, p.pool, requiredAmount);
  }

  // 3. Simulate. If success is false, bail before spending gas.
  const sim = await ctx.publicClient.simulateContract({
    address: p.pool,
    abi: SPOT_POOL_ABI,
    functionName: "placeOrder",
    args,
    account: ctx.account,
    value,
  });
  const [ok] = sim.result;
  if (!ok) {
    throw new GotchaError("SIM_FALSE", `placeOrder simulation returned success=false (would silently reject).`);
  }

  // Gas: estimate for real (simulateContract does not populate a gas limit), then
  // apply headroom and a floor. Native-base ops are gas-heavy; native BUYs must
  // additionally clear the payout guard (>=5M), and estimateGas can itself revert
  // on that guard, so we fall back to the floor.
  let estimate: bigint | undefined;
  try {
    estimate = await ctx.publicClient.estimateContractGas({
      address: p.pool, abi: SPOT_POOL_ABI, functionName: "placeOrder", args, account: ctx.account, value,
    });
  } catch {
    estimate = undefined;
  }
  const gas = pickGas(estimate, p.baseIsNative, p.isBid);

  // 4. Broadcast.
  const txHash = await ctx.walletClient.writeContract({ ...sim.request, gas, chain: ctx.walletClient.chain, account: ctx.account });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new GotchaError("TX_REVERTED", `placeOrder tx reverted: ${txHash}`);
  }

  // 5. Confirm OrderPlaced and read the real id from the receipt.
  const placed = receipt.logs.find((l) => l.topics[0]?.toLowerCase() === TOPIC.OrderPlaced.toLowerCase());
  if (!placed) {
    throw new GotchaError("SILENT_REJECTION", `tx mined but no OrderPlaced log — order was rejected: ${txHash}`);
  }
  const orderId = placed.topics[1] ? BigInt(placed.topics[1]) : null;

  return { txHash, orderId, gasUsed: receipt.gasUsed };
}

/**
 * Place an order ON BEHALF OF `owner` from an approved operator key (split-key /
 * session-key trading). Funds come from the owner's vault (owner must be in
 * manual vault mode and have deposited + granted the operator the placeOrderFor
 * selector — see operator.ts / docs/session-keys.md). No allowance or msg.value:
 * the operator never holds funds.
 */
export async function placeOrderFor(ctx: ExecCtx, p: PlaceOrderParams, owner: `0x${string}`): Promise<PlaceOrderResult> {
  const orderType = p.orderType ?? ORDER_TYPE.ImmediateOrCancel;
  assertExpireNs(p.expireTimestampNs);
  assertPriceRawNonZero(p.priceRaw);
  assertPriceMultipleOfTick(p.priceRaw, p.tickRaw);
  assertQtyAboveMin(p.quantityRaw, p.minQtyRaw);
  assertQtyMultipleOfLot(p.quantityRaw, p.lotRaw);
  assertBuilderDisabled(zeroAddress, 0n);

  const args = [
    owner, p.isBid, p.userData ?? 0n, p.priceRaw, p.quantityRaw, p.expireTimestampNs,
    orderType, SELF_MATCH.CancelTaker, zeroAddress, 0n,
  ] as const;

  const sim = await ctx.publicClient.simulateContract({ address: p.pool, abi: SPOT_POOL_ABI, functionName: "placeOrderFor", args, account: ctx.account, value: 0n });
  const [ok] = sim.result;
  if (!ok) throw new GotchaError("SIM_FALSE", "placeOrderFor simulation returned success=false (owner in manual vault mode + deposited + operator approved?).");

  let estimate: bigint | undefined;
  try {
    estimate = await ctx.publicClient.estimateContractGas({ address: p.pool, abi: SPOT_POOL_ABI, functionName: "placeOrderFor", args, account: ctx.account, value: 0n });
  } catch {
    estimate = undefined;
  }
  const gas = pickGas(estimate, p.baseIsNative, p.isBid);

  const txHash = await ctx.walletClient.writeContract({ ...sim.request, gas, chain: ctx.walletClient.chain, account: ctx.account });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new GotchaError("TX_REVERTED", `placeOrderFor tx reverted: ${txHash}`);
  const placed = receipt.logs.find((l) => l.topics[0]?.toLowerCase() === TOPIC.OrderPlaced.toLowerCase());
  if (!placed) throw new GotchaError("SILENT_REJECTION", `tx mined but no OrderPlaced log — order rejected: ${txHash}`);
  return { txHash, orderId: placed.topics[1] ? BigInt(placed.topics[1]) : null, gasUsed: receipt.gasUsed };
}

/** Cancel an owner's order from an approved operator key. */
export async function cancelOrderFor(ctx: ExecCtx, pool: `0x${string}`, owner: `0x${string}`, orderId: bigint): Promise<`0x${string}`> {
  const sim = await ctx.publicClient.simulateContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "cancelOrderFor", args: [owner, orderId], account: ctx.account });
  const hash = await ctx.walletClient.writeContract({ ...sim.request, chain: ctx.walletClient.chain, account: ctx.account });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function cancelOrder(ctx: ExecCtx, pool: `0x${string}`, orderId: bigint): Promise<`0x${string}`> {
  const sim = await ctx.publicClient.simulateContract({
    address: pool,
    abi: SPOT_POOL_ABI,
    functionName: "cancelOrder",
    args: [orderId],
    account: ctx.account,
  });
  const hash = await ctx.walletClient.writeContract({ ...sim.request, chain: ctx.walletClient.chain, account: ctx.account });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Approve `spender` to pull at least `amount` of `token`, if the current allowance is short. */
export async function ensureAllowance(
  ctx: ExecCtx,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const current = await ctx.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.account.address, spender],
  });
  if (current >= amount) return;
  const hash = await ctx.walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    // Approve a generous multiple so we don't approve on every order.
    args: [spender, amount * 8n],
    chain: ctx.walletClient.chain,
    account: ctx.account,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
}

function pickGas(estimate: bigint | undefined, baseIsNative: boolean, isBid: boolean): bigint {
  // Floors: native BUY needs the 5M payout headroom; native SELL is still
  // gas-heavy (native-value handling) so give it room; ERC-20 ops are light.
  const floor = baseIsNative ? (isBid ? NATIVE_BASE_BUY_GAS : 2_000_000n) : DEFAULT_GAS_FLOOR;
  const withHeadroom = estimate ? (estimate * 13n) / 10n : floor;
  return withHeadroom > floor ? withHeadroom : floor;
}
