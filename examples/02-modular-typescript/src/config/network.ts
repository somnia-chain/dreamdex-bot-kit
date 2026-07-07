/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";

export type NetworkName = "mainnet" | "testnet";

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly chainId: number;
  readonly nativeSymbol: string;
  readonly rpc: string;
  readonly restApi: string;
  readonly wsUrl: string;
  readonly explorer: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    name: "mainnet",
    chainId: 5031,
    nativeSymbol: "SOMI",
    rpc: process.env.MAINNET_RPC ?? "https://api.infra.mainnet.somnia.network",
    restApi: process.env.MAINNET_REST_API ?? "https://api.dreamdex.io/v0",
    wsUrl: process.env.MAINNET_WS ?? "wss://api.dreamdex.io/v0/ws/public",
    explorer: "https://explorer.somnia.network",
  },
  testnet: {
    name: "testnet",
    chainId: 50312,
    nativeSymbol: "STT",
    rpc: process.env.TESTNET_RPC ?? "https://dream-rpc.somnia.network",
    restApi: process.env.TESTNET_REST_API ?? "https://stg.api.dreamdex.io/v0",
    wsUrl: process.env.TESTNET_WS ?? "wss://stg.api.dreamdex.io/v0/ws/public",
    explorer: "https://shannon-explorer.somnia.network",
  },
};

export function getActiveNetwork(): NetworkConfig {
  const raw = (process.env.NETWORK ?? "testnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(
      `Invalid NETWORK="${raw}". Must be "mainnet" or "testnet".`,
    );
  }
  return NETWORKS[raw];
}
