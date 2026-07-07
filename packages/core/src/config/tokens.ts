/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Token + market address book.
//
// These are convenience constants. The canonical, always-current source of
// truth is `GET /v0/markets` (see rest.ts `fetchMarkets`) and `getPoolParams()`
// on-chain — query them at runtime rather than trusting a hard-coded list.
//
// GOTCHA — the native SOMI sentinel. On the SOMI:USDso pool, SOMI is the chain's
// native token and has no ERC-20 contract. Vault-balance reads for the native
// side use this sentinel address, NOT address(0). See docs/gotchas.md.

import type { NetworkName } from "./networks.js";

export const NATIVE_SENTINEL = "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00" as const;

export interface MarketMeta {
  readonly symbol: string;
  readonly pool: `0x${string}`;
  readonly stopRegistry: `0x${string}`;
  readonly baseDecimals: number;
  readonly quoteDecimals: number; // USDso is 18 on every pool
  readonly baseIsNative: boolean;
}

// Quote is USDso (18 decimals) on every pool.
export const MARKETS: Record<NetworkName, Record<string, MarketMeta>> = {
  mainnet: {
    "SOMI:USDso": {
      symbol: "SOMI:USDso",
      pool: "0x035De7403eac6872787779CCA7CCF1b4CDb61379",
      stopRegistry: "0x68c8f6fb1EA19A28F25358Ff00b8Ed8E1216df30",
      baseDecimals: 18,
      quoteDecimals: 18,
      baseIsNative: true,
    },
    "USDC.e:USDso": {
      symbol: "USDC.e:USDso",
      pool: "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b",
      stopRegistry: "0xD53E3F3b73513F2147377ef8f573f649cF60100c",
      baseDecimals: 6,
      quoteDecimals: 18,
      baseIsNative: false,
    },
    "WBTC:USDso": {
      symbol: "WBTC:USDso",
      pool: "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA",
      stopRegistry: "0xed32F048D6a47923D38eCeD868d6f8b0eB4852bd",
      baseDecimals: 8,
      quoteDecimals: 18,
      baseIsNative: false,
    },
    "WETH:USDso": {
      symbol: "WETH:USDso",
      pool: "0xa936da11B57b50A344e1293AAaE5232885ea2bDE",
      stopRegistry: "0x9653a7355849B7691802A6AA49fDe18eF5ba633d",
      baseDecimals: 18,
      quoteDecimals: 18,
      baseIsNative: false,
    },
  },
  testnet: {
    "SOMI:USDso": {
      symbol: "SOMI:USDso",
      pool: "0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
      stopRegistry: "0xEb97349Aa62A68507c0bE535eD88B0d028a47E1e",
      baseDecimals: 18,
      quoteDecimals: 18,
      baseIsNative: true,
    },
    "WBTC:USDso": {
      symbol: "WBTC:USDso",
      pool: "0x3605f28aA7C50e7441211e77Cb0762d49539326C",
      stopRegistry: "0x53d5B2b0791b3992a1F3b5e0b0277Ee2e08B7aaD",
      baseDecimals: 8,
      quoteDecimals: 18,
      baseIsNative: false,
    },
    "WETH:USDso": {
      symbol: "WETH:USDso",
      pool: "0xD180195da5459C7a0DEA188ed61216ec43682b50",
      stopRegistry: "0xf822D4Cb94902d667c9650e702aA5f096cc7598F",
      baseDecimals: 18,
      quoteDecimals: 18,
      baseIsNative: false,
    },
  },
};
