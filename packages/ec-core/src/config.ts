/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Config for the kit. Addresses + chainId come from the bundled deployment map
// (addresses.ts); only the endpoints (RPC/WS/indexer), the signer, and the venue
// scope live in .env. Any single address can still be overridden from .env when
// a redeploy lands before this kit is updated.
//
// NETWORK selects the deployment: "testnet" (default) | "mainnet" — the same
// variable the spot side and the Railway entrypoint already use, so one repo
// speaks one dialect. DEPLOY_ENV is still honoured as a fallback for anyone
// carrying it over from the standalone EC kit.

import { defineChain, type Chain } from "viem";
import { SOMNIA_TESTNET_PRICE_FEED, type PriceFeedConfig } from "@somnia-chain/markets-sdk";
import { DEPLOYMENTS, type Address, type EcAddresses } from "./addresses.js";
import { config as dotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Network = "testnet" | "mainnet";
export type { EcAddresses, Address } from "./addresses.js";
export type { PriceFeedConfig } from "@somnia-chain/markets-sdk";

let envLoaded = false;
/** Load the nearest .env walking up from `startDir`, so an example in
 *  examples/<name> picks up the repo-root .env. Existing vars win (idempotent). */
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

const num = (name: string, def: number) => (process.env[name] ? Number(process.env[name]) : def);

/** Per-address .env overrides, for when a redeploy lands before this kit ships
 *  an updated addresses.ts. e.g. `BINARY_MODULE=0x…`, `COLLATERAL=0x…`. */
const ADDRESS_OVERRIDES: Record<string, keyof EcAddresses> = {
  COLLATERAL: "collateral",
  TEST_USDC: "testUsdc",
  BINARY_MODULE: "binaryModule",
  MARKETS_CORE: "marketsCore",
  MARKET_CREATOR: "marketCreator",
  CLOB_FACTORY: "clobFactory",
  BINARY_POOL_IMPL: "binaryPoolImpl",
  BINARY_SETTLEMENT: "binarySettlement",
  COLLATERAL_ROUTER: "collateralRouter",
  MARKET_CREATOR_FACTORY: "marketCreatorFactory",
  ORACLE_HUB: "oracleHub",
};

/** The price-feed endpoint for a network: bundled on testnet, env-only on mainnet.
 *  PRICE_FEED_URL overrides either; PRICE_FEED_QUOTE pins the quote asset (the
 *  feed indexes several quotes per base, so an unpinned read double-counts). */
function resolvePriceFeed(net: Network): PriceFeedConfig | undefined {
  const url = (process.env.PRICE_FEED_URL ?? "").trim();
  const quote = (process.env.PRICE_FEED_QUOTE ?? "").trim();
  const base = net === "testnet" ? SOMNIA_TESTNET_PRICE_FEED : undefined;
  if (!url && !base) return undefined;
  return {
    url: url || base!.url,
    quote: quote || base?.quote || "USDC",
  };
}

function resolveAddresses(net: Network): EcAddresses {
  const out: EcAddresses = { ...DEPLOYMENTS[net].addresses };
  for (const [envVar, key] of Object.entries(ADDRESS_OVERRIDES)) {
    const v = (process.env[envVar] ?? "").trim();
    if (v) out[key] = v as Address;
  }
  return out;
}

/**
 * A numeric env var, or the fallback — never NaN.
 *
 * `Number(process.env.MM_QUOTE_SIZ)` on a typo is NaN, and NaN flows straight
 * into a size or a cap and disables it without a word. Anything set but not a
 * number is a configuration error and says so.
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

export interface EcConfig {
  network: Network;
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  addresses: EcAddresses;
  /** Collateral decimals: 6 on testnet (tUSDC), 18 on mainnet (USDso). */
  decimals: number;
  /** Scope reads/trades to the DreamDEX venue. Leave both unset = all binary
   *  markets on the deployment (which today IS the DreamDEX venue). */
  venueId?: `0x${string}`;
  operatorId?: number;
  /** Signer for writes; undefined = read-only. */
  privateKey?: `0x${string}`;
  /**
   * The realtime price-feed indexer — the UNDERLYING BTC/ETH spot + EMA mark,
   * keyed by asset. Distinct from anything on a market row: `fetchOrderBook`
   * and `watchPrice`-on-a-symbol give you the event contract's OWN price (a
   * probability), which is circular as a directional signal. Only the feed
   * knows where BTC actually is.
   *
   * Mainnet has no bundled endpoint yet — set PRICE_FEED_URL there, or leave
   * it unset and the SDK's price methods stay dormant (nothing else needs it).
   */
  priceFeed?: PriceFeedConfig;
  /** Book granularity (raw units) — must match the live venue book. */
  tick: bigint;
  lot: bigint;
  /** Shares of YES/NO to mint per market for SELL inventory (mint-a-pair). */
  inventory: number;
  /** Max markets to act on per cycle. */
  maxMarkets: number;
  /** tUSDC faucet — auto-off on mainnet; FAUCET_ENABLED overrides. */
  faucetEnabled: boolean;
  /** When true, examples log intended actions instead of sending them. */
  dryRun: boolean;
}

/** Public RPC/WS defaults per network (stable). The indexer URL moves — the demo
 *  stack has relocated before — so confirm it in the somnia-markets DEPLOYMENTS.md. */
const ENDPOINTS: Record<"testnet" | "mainnet", { rpc: string; ws: string; indexer: string }> = {
  // One host per environment since the terraform migration (somnia-markets
  // PR #130): dev.smk = testnet, prd.smk = mainnet, chain at the ROOT path.
  testnet: {
    rpc: "https://api.infra.testnet.somnia.network",
    ws: "wss://api.infra.testnet.somnia.network/ws",
    indexer: "https://dev.smk.somnia.host/v1/graphql",
  },
  // Mainnet (chainId 5031) — the live USDso venue.
  mainnet: {
    rpc: "https://api.infra.mainnet.somnia.network",
    ws: "wss://api.infra.mainnet.somnia.network/ws",
    indexer: "https://prd.smk.somnia.host/v1/graphql",
  },
};

/** Read + validate the environment into an `EcConfig`. Call `loadEnv()` first
 *  (createExchange does). */
export function loadConfig(): EcConfig {
  loadEnv();
  // NETWORK first: the Railway entrypoint prints it in its banner, so reading a
  // different variable here would let the log say mainnet while the bot traded
  // testnet.
  const raw = (process.env.NETWORK ?? process.env.DEPLOY_ENV ?? "testnet").toLowerCase();
  const network: Network = raw === "mainnet" ? "mainnet" : "testnet";
  const deployment = DEPLOYMENTS[network];
  const ep = ENDPOINTS[network];

  const pk = (process.env.PRIVATE_KEY ?? process.env.TAKER_PRIVATE_KEY ?? "").trim();
  const venueId = (process.env.VENUE_ID ?? "").trim();
  const operatorId = (process.env.OPERATOR_ID ?? "").trim();

  return {
    network,
    chainId: num("CHAIN_ID", deployment.chainId),
    rpcUrl: process.env.RPC_URL ?? ep.rpc,
    wsRpcUrl: process.env.WS_RPC_URL ?? ep.ws,
    indexerUrl: process.env.INDEXER_URL ?? ep.indexer,
    addresses: resolveAddresses(network),
    decimals: num("DECIMALS", deployment.decimals),
    venueId: venueId ? (venueId as `0x${string}`) : undefined,
    operatorId: operatorId ? Number(operatorId) : undefined,
    privateKey: pk ? (pk as `0x${string}`) : undefined,
    priceFeed: resolvePriceFeed(network),
    // Book granularity. The binary venue's tick/lot are NOT discoverable through
    // the SDK (binary market rows carry no tickSize/lotSize, unlike spot/perp),
    // so they come from config.
    //   mainnet: 1e15 for both, per venues.json `bookParams` on the USDso venue.
    //   testnet: 1e3 for both (0.001 share). Measured 2026-09-22: every live
    //            testnet pool returns getOrderBookParameters() = 1000/1000/1000,
    //            and a quantity of 1500 reverts InvalidQuantity(1500, 1000).
    // Override if a venue changes them.
    tick: BigInt(num("MM_TICK", network === "mainnet" ? 1_000_000_000_000_000 : 1_000)),
    lot: BigInt(num("MM_LOT", network === "mainnet" ? 1_000_000_000_000_000 : 1_000)),
    inventory: num("MM_INVENTORY", network === "mainnet" ? 1 : 200),
    maxMarkets: num("MM_MAX_MARKETS", 8),
    faucetEnabled:
      process.env.FAUCET_ENABLED !== undefined ? process.env.FAUCET_ENABLED !== "false" : network !== "mainnet",
    dryRun: (process.env.DRY_RUN ?? "true") !== "false" && process.env.DRY_RUN !== "0",
  };
}

/** The viem chain for this config. */
export function makeChain(cfg: EcConfig): Chain {
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
