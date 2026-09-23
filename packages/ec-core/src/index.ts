/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// EC core — a thin, opinionated wrapper over @somnia-chain/markets-sdk
// scoped to the DreamDEX event-contracts venue. Import from here in your bots.

export { createExchange, shutdown, assertTxOk, type EcContext } from "./exchange.js";
export {
  loadConfig,
  envNum,
  loadEnv,
  makeChain,
  type EcConfig,
  type EcAddresses,
  type Network,
  type PriceFeedConfig,
} from "./config.js";
export { DEPLOYMENTS, type NetworkDeployment } from "./addresses.js";
export {
  activeMarkets,
  marketOnchain,
  inVenue,
  resolveVenue,
  venueOf,
  operatorOf,
  outcomeSymbols,
  isTradable,
  snapshot,
  settledMarkets,
  explainEmptyScope,
  toRawUnits,
  quantize,
  MARKET_STATUS,
  type EcSnapshot,
  type VenueScope,
} from "./markets.js";
export { seedInventory } from "./inventory.js";
export {
  placeLimit,
  cancelTracked,
  cancelVenueOrders,
  tryCancel,
  isOrderGone,
  netPosition,
  untrackOrder,
  sellableSize,
  cancelById,
  headroomSec,
  minLeftSec,
  type Outcome,
  type PlaceLimitArgs,
  type PlacedOrder,
} from "./orders.js";

export {
  assertProbability,
  clampProbability,
  assertTradable,
  assertInventoryForSell,
  noPrice,
} from "./gotchas.js";
export {
  estimatePayout,
  settlementFeeBps,
  claimableOutcomes,
  redeemOutcome,
  outcomeIdxOf,
  type OutcomeIdx,
} from "./settlement.js";
export {
  maybeClaim,
  claimSettled,
  redeemHoldings,
  autoClaimEnabled,
  type ClaimOptions,
} from "./claim.js";

// Re-export the SDK's converters + core types so bots have one import surface.
export {
  probabilityToPrice,
  priceToProbability,
  fromHuman,
  toHuman,
  type SomniaMarkets,
  type UnifiedMarket,
  type UnifiedOrder,
  type UnifiedOrderBook,
  type UnifiedPrice,
  type MarketOnchain,
} from "@somnia-chain/markets-sdk";
