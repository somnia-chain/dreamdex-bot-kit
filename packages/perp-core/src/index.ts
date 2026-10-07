/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Perp core: a thin wrapper over @somnia-chain/markets-sdk for the perpetual
// markets. Import from here in your bots.

export {
  createExchange,
  tradingKeyCheck,
  shutdown,
  assertTxOk,
  sleep,
  onStop,
  type PerpContext,
} from "./exchange.js";
export {
  createTradingKey,
  linkStatus,
  linkProblem,
  placeFor,
  cancelFor,
  reduceFor,
  TRADING_KEY_SELECTOR,
  type TradingKey,
  type LinkStatus,
} from "./operator.js";
export {
  loadConfig,
  loadEnv,
  makeChain,
  envNum,
  envBool,
  type PerpConfig,
  type Network,
} from "./config.js";
export {
  perpMarkets,
  requireMarket,
  displayName,
  toRaw,
  fromRaw,
  alignPrice,
  alignQuantity,
  sizeForNotional,
  markOf,
  markAgeSec,
  liveMark,
  indexOf,
  type PerpMarket,
  type PerpInfo,
} from "./markets.js";
export {
  preflight,
  marginSnapshot,
  healthRatio,
  marginForNotional,
  ensureLeverage,
  type MarginSnapshot,
  type PreflightResult,
} from "./margin.js";
export {
  sizeOrder,
  placePerp,
  cancelQuietly,
  positionIn,
  closePosition,
  type WriteCtx,
  type Side,
  type SizingResult,
  type PlaceResult,
} from "./orders.js";
export {
  armBracket,
  cancelStops,
  pendingStops,
  somiPerStop,
  isRealStopFailure,
  TRIGGER_GTE,
  TRIGGER_LTE,
  STOP_MARKET,
  type BracketResult,
} from "./stops.js";
export {
  fundingApr,
  fundingSide,
  type FundingView,
} from "./funding.js";

// Re-export the SDK pieces a strategy needs, so bots have one import surface.
export { ORDER_TYPE, type SomniaMarkets, type UnifiedMarket } from "@somnia-chain/markets-sdk";
