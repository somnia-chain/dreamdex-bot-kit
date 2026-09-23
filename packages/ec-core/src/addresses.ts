/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// The deployed contract addresses the SDK needs, per network.
//
// These are bundled rather than pulled from `@somnia-chain/deployments`: that
// package is not installable outside the somnia-markets monorepo (it is marked
// private, and its `src` imports the JSON manifests through paths that escape
// the package, so a published copy cannot resolve them). Bundling keeps this kit
// installable from a plain `npm install`.
//
// Verified against smart-contracts/deployments/<chainId>/ on 2026-07-24.
// `clobFactory`, `binaryPoolImpl` and `binaryPoolBeacon` re-checked on-chain on
// 2026-09-22, both networks: the module's `clobFactory()` and the beacon's
// `implementation()`. They match markets-sdk 0.30.0's bundled addresses.
// The protocol core is CREATE3-deterministic, so it is identical on both
// networks; only `marketCreator` and the collateral token differ.
//
// To refresh: read the addresses.json for the network in the somnia-markets repo
// (or the table in its DEPLOYMENTS.md) and update the map below. Any single
// address can also be overridden from .env without editing this file — see
// `ADDRESS_OVERRIDES` in config.ts. `npm run ec:doctor` verifies the module address
// actually has code on-chain, so a stale entry fails loudly.

export type Address = `0x${string}`;

/** The address set fed straight into `new SomniaMarkets({ addresses })`. */
export interface EcAddresses {
  collateral?: Address;
  testUsdc?: Address;
  binaryModule?: Address;
  marketsCore?: Address;
  marketCreator?: Address;
  clobFactory?: Address;
  binaryPoolImpl?: Address;
  binaryPoolBeacon?: Address;
  binarySettlement?: Address;
  collateralRouter?: Address;
  marketCreatorFactory?: Address;
  oracleHub?: Address;
  operatorPermissionsRegistry?: Address;
  fakeOracle?: Address;
}

/** Protocol core — CREATE3, identical across chains. */
const CORE = {
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  clobFactory: "0x1a478019Ae4d24249a962934af0f129CE98B5e6f",
  // Every pool is a beacon proxy on `binaryPoolBeacon`; `binaryPoolImpl` is what
  // the beacon resolves to today. The previous value,
  // 0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD, is the implementation behind the
  // pre-beacon pools, not an older beacon target.
  binaryPoolImpl: "0x48e523c9f22f98548d263f0aD444D732e5202C0E",
  binaryPoolBeacon: "0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
} as const satisfies Partial<EcAddresses>;

export interface NetworkDeployment {
  chainId: number;
  /** Collateral decimals: 6 (tUSDC) on testnet, 18 (USDso) on mainnet. */
  decimals: number;
  addresses: EcAddresses;
}

export const DEPLOYMENTS: Record<"testnet" | "mainnet", NetworkDeployment> = {
  testnet: {
    chainId: 50312,
    decimals: 6,
    addresses: {
      ...CORE,
      // TestUSDC faucet (public `faucet(uint256)`, 6 dp)
      collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
      testUsdc: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
      // venue 2's creator — the venue the LIVE markets sit on (venue 1's
      // creator 0x46fB24… is idle). Only used as an extra live-tail discovery
      // source; the module (which emits every MarketCreated) covers discovery
      // regardless, so a stale value here degrades nothing.
      marketCreator: "0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6",
    },
  },
  mainnet: {
    chainId: 5031,
    decimals: 18,
    addresses: {
      ...CORE,
      // USDso — a real stablecoin, 18 dp, no faucet
      collateral: "0x00000022dA000002656c64D9eA6011ea952D008A",
      testUsdc: "0x00000022dA000002656c64D9eA6011ea952D008A",
      marketCreator: "0x62627805965705Cc303A7F6282DD5059921980aD",
    },
  },
};
