/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { NetworkName } from "./network.js";

export interface TokenInfo {
  readonly symbol: string;
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly isNative?: boolean;
}

export const TOKENS: Record<NetworkName, Record<string, TokenInfo>> = {
  mainnet: {
    USDso: {
      symbol: "USDso",
      address: "0x00000022dA000002656c64D9eA6011ea952D008A",
      decimals: 18,
    },
    SOMI: {
      symbol: "SOMI",
      address: "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00",
      decimals: 18,
      isNative: true,
    },
    "USDC.e": {
      symbol: "USDC.e",
      address: "0x28BEc7E30E6faee657a03e19Bf1128AaD7632A00",
      decimals: 6,
    },
    WETH: {
      symbol: "WETH",
      address: "0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0xC5098b3cA516784323872F17235fa074E167D3D2",
      decimals: 8,
    },
  },
  testnet: {
    USDso: {
      symbol: "USDso",
      address: "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171",
      decimals: 18,
    },
    SOMI: {
      symbol: "SOMI",
      address: "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00",
      decimals: 18,
      isNative: true,
    },
    WETH: {
      symbol: "WETH",
      address: "0x4d8E02BBfCf205828A8352Af4376b165E123D7b0",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x4e85DC48a70DA1298489d5B6FC2492767d98f384",
      decimals: 8,
    },
  },
};

export function getToken(network: NetworkName, symbol: string): TokenInfo {
  const t = TOKENS[network][symbol];
  if (!t) {
    throw new Error(`Token ${symbol} not configured on ${network}`);
  }
  return t;
}
