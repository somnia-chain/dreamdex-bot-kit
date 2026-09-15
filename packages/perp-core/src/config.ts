/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Config for the perp strategies. Endpoints and the signer come from .env; the
// per-market addresses (pool, MarginBank, stop registry) are read off the market
// row at runtime and are never configured, because a market can be re-pointed at
// a new pool without its symbol changing.
//
// NETWORK selects the deployment, the same variable the spot and EC families
// already read. Perp pools exist on testnet only today, so `mainnet` is refused
// at startup rather than trading against an empty market list.

import { defineChain, type Chain } from "viem";
import { config as dotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Network = "testnet" | "mainnet";

let envLoaded = false;
/** Load the nearest .env walking up from `startDir`, so a strategy in
 *  strategies/<name> picks up the repo-root .env. Existing vars win. */
export function loadEnv(startDir = process.cwd()): void {
  if (envLoaded) return;
  envLoaded = true;
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return void dotenv({ path: candidate });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv();
}

/**
 * A numeric env var, or the fallback, never NaN.
 *
 * `Number(process.env.PERP_LEVERAG)` on a typo is NaN, and NaN flows straight
 * into a size or a cap and disables it without a word.
 */
export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name}="${raw}" is not a number. Unset it to use the default (${fallback}).`);
  }
  return n;
}

/** A boolean env var. Anything but "false"/"0" reads as true when set. */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw !== "false" && raw !== "0";
}

/**
 * The OperatorPermissionsRegistry, which arming a stop order needs.
 *
 * It is NOT in the SDK's bundled address sets (neither SOMNIA_TESTNET_ADDRESSES
 * nor the mainnet one carries the key), so `placePerpStopOrder` throws
 * `NotConfiguredError` unless it is passed explicitly. Overridable from .env for
 * the redeploy case.
 */
const OPERATOR_REGISTRY: Record<Network, `0x${string}`> = {
  testnet: "0x15C7e8CE38F021c5b45d098AaD788f63090bF20A",
  // No perp deployment on mainnet yet; kept so the shape is total and the
  // refusal below stays the single place that says so.
  mainnet: "0x0000000000000000000000000000000000000000",
};

const ENDPOINTS: Record<Network, { rpc: string; ws: string; indexer: string; chainId: number }> = {
  testnet: {
    rpc: "https://api.infra.testnet.somnia.network",
    ws: "wss://api.infra.testnet.somnia.network/ws",
    indexer: "https://dev.smk.somnia.host/v1/graphql",
    chainId: 50312,
  },
  mainnet: {
    rpc: "https://api.infra.mainnet.somnia.network",
    ws: "wss://api.infra.mainnet.somnia.network/ws",
    indexer: "https://prd.smk.somnia.host/v1/graphql",
    chainId: 5031,
  },
};

export interface PerpConfig {
  network: Network;
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  /** Registry that authorises the stop registry to place on the owner's behalf. */
  operatorRegistry: `0x${string}`;
  /** The market to trade, app-canonical `BASE-PERP`. Blank means every market
   *  the account holds a position in, which only perp-guard uses. */
  symbol: string;
  /** Signer for writes; undefined = read-only. */
  privateKey?: `0x${string}`;
  /** When true, strategies log intended orders instead of sending them. */
  dryRun: boolean;
}

/**
 * Read and validate the environment.
 *
 * Refuses `NETWORK=mainnet` outright: the perp contracts live on Shannon
 * testnet and the SDK ships those addresses alone, so a mainnet run would
 * connect, find `type === "swap"` empty, and sit there looking healthy. The
 * builder disables the mainnet option for perps, but a hand-edited .env reaches
 * here, which is the case this refusal exists for.
 */
export function loadConfig(): PerpConfig {
  loadEnv();
  const raw = (process.env.NETWORK ?? "testnet").toLowerCase();
  if (raw === "mainnet") {
    throw new Error(
      "NETWORK=mainnet: there are no perp markets on Somnia mainnet yet, so this bot has nothing to trade. " +
        "Perp pools are deployed on Shannon testnet (chain 50312); set NETWORK=testnet, or wait for the mainnet launch.",
    );
  }
  const network: Network = "testnet";
  const ep = ENDPOINTS[network];
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  const registry = (process.env.OPERATOR_PERMISSIONS_REGISTRY ?? "").trim();

  return {
    network,
    chainId: Math.trunc(envNum("CHAIN_ID", ep.chainId)),
    rpcUrl: process.env.RPC_URL ?? ep.rpc,
    wsRpcUrl: process.env.WS_RPC_URL ?? ep.ws,
    indexerUrl: process.env.INDEXER_URL ?? ep.indexer,
    operatorRegistry: (registry || OPERATOR_REGISTRY[network]) as `0x${string}`,
    symbol: (process.env.PERP_SYMBOL ?? "").trim(),
    privateKey: pk ? (pk as `0x${string}`) : undefined,
    dryRun: envBool("DRY_RUN", true),
  };
}

/** The viem chain for this config. */
export function makeChain(cfg: PerpConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: `somnia-${cfg.chainId}`,
    nativeCurrency:
      cfg.chainId === 5031
        ? { name: "Somnia", symbol: "SOMI", decimals: 18 }
        : { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl], webSocket: [cfg.wsRpcUrl] } },
  });
}
