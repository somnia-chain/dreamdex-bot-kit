/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// SpotPool contract surface (the modern, post-June-2026-upgrade ABI) plus typed read
// helpers and the event topic0 hashes you need for reading fills off-chain.
//
// Only the functions a bot actually uses are included. Admin entrypoints are
// omitted. Full reference: https://docs.dreamdex.io (Developers → Contracts).

import type { PublicClient } from "viem";

export const SPOT_POOL_ABI = [
  // ── Orders ────────────────────────────────────────────────────────────────
  // NOTE: `placeOrder` is the single, payable entry point. The old
  // `placeTakerOrderWithoutVault` was REMOVED in the June 2026 upgrade — do not use it.
  {
    type: "function",
    name: "placeOrder",
    stateMutability: "payable",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "orderId", type: "uint128" },
    ],
  },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "uint128" }], outputs: [] },
  {
    type: "function",
    name: "reduceOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint128" },
      { name: "newQuantityRemaining", type: "uint256" },
    ],
    outputs: [],
  },
  // ── Vault (manual mode / native) ──────────────────────────────────────────
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "depositNative", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  // ── Reads ─────────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getPoolParams",
    stateMutability: "view",
    inputs: [],
    // ORDER MATTERS: makerFee precedes takerFee, and tick → minQuantity → lot.
    outputs: [
      { name: "baseToken_", type: "address" },
      { name: "quoteToken_", type: "address" },
      { name: "makerFeeBpsTimes1k_", type: "uint256" },
      { name: "takerFeeBpsTimes1k_", type: "uint256" },
      { name: "tickSize_", type: "uint256" },
      { name: "minQuantity_", type: "uint256" },
      { name: "lotSize_", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getBookLevels",
    stateMutability: "view",
    inputs: [{ name: "isBid", type: "bool" }, { name: "numLevels", type: "uint64" }],
    outputs: [{ name: "", type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }],
  },
  { type: "function", name: "getWithdrawableBalance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128[]" }] },
  {
    type: "function",
    name: "getAutoPullRequirement",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "isBid", type: "bool" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "inputToken", type: "address" },
      { name: "requiredAmount", type: "uint256" },
      { name: "delta", type: "uint256" },
    ],
  },
  // ── Operator / split-key surface ───────────────────────────────────────────
  // Place / cancel an order on behalf of `owner`, from an approved operator key.
  {
    type: "function",
    name: "placeOrderFor",
    stateMutability: "payable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [{ name: "success", type: "bool" }, { name: "orderId", type: "uint128" }],
  },
  { type: "function", name: "cancelOrderFor", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "orderId", type: "uint128" }], outputs: [] },
  { type: "function", name: "setManualVaultMode", stateMutability: "nonpayable", inputs: [{ name: "enabled", type: "bool" }], outputs: [] },
  { type: "function", name: "getManualVaultMode", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "isOperatorAuthorized", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }, { name: "selector", type: "bytes4" }], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "orderId", type: "uint128" }, { name: "isBid", type: "bool" }, { name: "owner", type: "address" }, { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" }, { name: "fullQuantity", type: "uint256" }, { name: "quantityRemaining", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" },
    ] }],
  },
] as const;

/** OperatorPermissionsRegistry — grant/revoke operator approvals (owner key). */
export const OPERATOR_REGISTRY_ABI = [
  { type: "function", name: "setOperatorApprovalForPool", stateMutability: "nonpayable", inputs: [{ name: "pool", type: "address" }, { name: "operator", type: "address" }, { name: "selectors", type: "bytes4[]" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "setOperatorApprovalGlobal", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "selectors", type: "bytes4[]" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "setOperatorDenialForPool", stateMutability: "nonpayable", inputs: [{ name: "pool", type: "address" }, { name: "operator", type: "address" }, { name: "selectors", type: "bytes4[]" }, { name: "denied", type: "bool" }], outputs: [] },
] as const;

/** Per-selector operator capability identifiers (see the operator docs). */
export const OPERATOR_SELECTOR = {
  placeOrderFor: "0x80054449",
  cancelOrderFor: "0xe37b444b",
  reduceOrderFor: "0x364c2587",
} as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

// Event topic0 hashes. Pin these from the docs — do NOT hand-roll them from a
// signature string, or you will silently mismatch after a signature change
// (the OrderFilled signature gained `fillPrice` in the June 2026 upgrade).
export const TOPIC = {
  OrderPlaced: "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d",
  // OrderFilled(uint128,uint128,uint256,uint256,uint256,uint256) — 6 args.
  OrderFilled: "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399",
  OrderCancelled: "0x06ff08ed6b6987bb7df963009d8b54dc03988f4e465c009924929bb010fe03e7",
  OrderExpired: "0x6003d149bc2c6baa0780d4302ad5f925fef5715780d3b6f7d2da5476548da101",
} as const;

export interface PoolParams {
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  makerFeeBpsTimes1k: bigint;
  takerFeeBpsTimes1k: bigint;
  tickSize: bigint;
  minQuantity: bigint;
  lotSize: bigint;
}

export async function readPoolParams(client: PublicClient, pool: `0x${string}`): Promise<PoolParams> {
  const r = await client.readContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "getPoolParams" });
  return {
    baseToken: r[0],
    quoteToken: r[1],
    makerFeeBpsTimes1k: r[2],
    takerFeeBpsTimes1k: r[3],
    tickSize: r[4],
    minQuantity: r[5],
    lotSize: r[6],
  };
}

export interface BookLevel {
  priceRaw: bigint;
  sizeRaw: bigint;
}

/**
 * Read aggregated book levels for one side. `getBookLevels` returns an empty
 * array on an empty book (it does NOT revert), so we let real RPC/ABI errors
 * propagate instead of masking them as an empty book.
 */
export async function readBookLevels(
  client: PublicClient,
  pool: `0x${string}`,
  isBid: boolean,
  depth = 5,
): Promise<BookLevel[]> {
  const levels = await client.readContract({
    address: pool,
    abi: SPOT_POOL_ABI,
    functionName: "getBookLevels",
    args: [isBid, BigInt(depth)],
  });
  return levels.map((l) => ({ priceRaw: l.price, sizeRaw: l.quantity }));
}

export async function readWithdrawableBalance(
  client: PublicClient,
  pool: `0x${string}`,
  owner: `0x${string}`,
  token: `0x${string}`,
): Promise<bigint> {
  return client.readContract({ address: pool, abi: SPOT_POOL_ABI, functionName: "getWithdrawableBalance", args: [owner, token] });
}
