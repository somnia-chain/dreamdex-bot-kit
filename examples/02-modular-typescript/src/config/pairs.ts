/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { NetworkName } from "./network.js";

export interface PoolConfig {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly poolAddress: `0x${string}`;
  readonly stopRegistry?: `0x${string}`;
  readonly tickSize: number;
  readonly lotSize: number;
  readonly minQuantity: number;
}

export const POOLS: Record<NetworkName, Record<string, PoolConfig>> = {
  mainnet: {
    "SOMI:USDso": {
      symbol: "SOMI:USDso",
      base: "SOMI",
      quote: "USDso",
      poolAddress: "0x035De7403eac6872787779CCA7CCF1b4CDb61379",
      stopRegistry: "0x68c8f6fb1EA19A28F25358Ff00b8Ed8E1216df30",
      tickSize: 0.0001,
      lotSize: 0.01,
      minQuantity: 1,
    },
    "USDC.e:USDso": {
      symbol: "USDC.e:USDso",
      base: "USDC.e",
      quote: "USDso",
      poolAddress: "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b",
      stopRegistry: "0xD53E3F3b73513F2147377ef8f573f649cF60100c",
      tickSize: 0.0001,
      // CONFIRMED on-chain via getPoolParams() on 2026-05-27: lotRaw=1000000 (= 1.0 USDC.e at 6 dec).
      // Docs / SKILL.md §4 said 0.01 — wrong. See Obs-005.
      lotSize: 1.0,
      minQuantity: 1,
    },
    "WBTC:USDso": {
      symbol: "WBTC:USDso",
      base: "WBTC",
      quote: "USDso",
      poolAddress: "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA",
      stopRegistry: "0xed32F048D6a47923D38eCeD868d6f8b0eB4852bd",
      tickSize: 0.1,
      lotSize: 0.00001,
      minQuantity: 0.0001,
    },
    "WETH:USDso": {
      symbol: "WETH:USDso",
      base: "WETH",
      quote: "USDso",
      poolAddress: "0xa936da11B57b50A344e1293AAaE5232885ea2bDE",
      stopRegistry: "0x9653a7355849B7691802A6AA49fDe18eF5ba633d",
      tickSize: 0.01,
      lotSize: 0.0001,
      minQuantity: 0.001,
    },
  },
  testnet: {
    "SOMI:USDso": {
      symbol: "SOMI:USDso",
      base: "SOMI",
      quote: "USDso",
      poolAddress: "0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
      stopRegistry: "0xEb97349Aa62A68507c0bE535eD88B0d028a47E1e",
      tickSize: 0.0001,
      lotSize: 0.01,
      minQuantity: 1,
    },
    "WBTC:USDso": {
      symbol: "WBTC:USDso",
      base: "WBTC",
      quote: "USDso",
      poolAddress: "0x3605f28aA7C50e7441211e77Cb0762d49539326C",
      stopRegistry: "0x53d5B2b0791b3992a1F3b5e0b0277Ee2e08B7aaD",
      tickSize: 0.1,
      lotSize: 0.00001,
      minQuantity: 0.0001,
    },
    "WETH:USDso": {
      symbol: "WETH:USDso",
      base: "WETH",
      quote: "USDso",
      poolAddress: "0xD180195da5459C7a0DEA188ed61216ec43682b50",
      stopRegistry: "0xf822D4Cb94902d667c9650e702aA5f096cc7598F",
      tickSize: 0.01,
      lotSize: 0.0001,
      minQuantity: 0.001,
    },
  },
};

export function getPool(network: NetworkName, symbol: string): PoolConfig {
  const p = POOLS[network][symbol];
  if (!p) {
    const available = Object.keys(POOLS[network]).join(", ");
    throw new Error(
      `Pool ${symbol} not configured on ${network}. Available: ${available}`,
    );
  }
  return p;
}
