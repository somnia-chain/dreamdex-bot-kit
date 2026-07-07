/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import 'dotenv/config';
import { Wallet } from 'ethers';
import type {
  AllowedSide,
  ExecutionMode,
  FundingSource,
  OrderType,
  SelfMatchingOption,
  StrategyMode,
} from '@trading/sdk';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optional = (name: string, fallback: string): string => {
  return process.env[name] ?? fallback;
};

const envName = optional('DREAMDEX_ENV', 'mainnet');
const strategy = optional('DREAMDEX_STRATEGY', 'threshold') as StrategyMode;
const baseUrl = optional(
  'DREAMDEX_BASE_URL',
  envName === 'staging'
    ? 'https://stg.api.dreamdex.io'
    : 'https://api.dreamdex.io',
);
const wsUrl = optional(
  'DREAMDEX_WS_URL',
  envName === 'staging'
    ? 'wss://stg.api.dreamdex.io/v0/ws/public'
    : 'wss://api.dreamdex.io/v0/ws/public',
);

const privateKey = required('DREAMDEX_PRIVATE_KEY');
const wallet = new Wallet(privateKey);
const chainId = Number(
  optional('DREAMDEX_CHAIN_ID', envName === 'staging' ? '50312' : '5031'),
);

export const config = {
  envName,
  baseUrl,
  wsUrl,
  chainId,
  rpcUrl: required('DREAMDEX_RPC_URL'),
  privateKey,
  walletAddress: wallet.address,
  symbol: required('DREAMDEX_SYMBOL'),
  strategy,
  executionMode: optional('DREAMDEX_EXECUTION_MODE', 'http') as ExecutionMode,
  orderAmount: required('DREAMDEX_ORDER_AMOUNT'),
  allowedSide: optional('DREAMDEX_ALLOWED_SIDE', 'both') as AllowedSide,
  buyBelowPrice: Number(
    strategy === 'threshold'
      ? required('DREAMDEX_BUY_BELOW_PRICE')
      : optional('DREAMDEX_BUY_BELOW_PRICE', '0'),
  ),
  sellAbovePrice: Number(
    strategy === 'threshold'
      ? required('DREAMDEX_SELL_ABOVE_PRICE')
      : optional('DREAMDEX_SELL_ABOVE_PRICE', '0'),
  ),
  fundingSource: optional('DREAMDEX_FUNDING_SOURCE', 'wallet') as FundingSource,
  orderType: optional('DREAMDEX_ORDER_TYPE', 'immediateOrCancel') as OrderType,
  selfMatchingOption: optional(
    'DREAMDEX_SELF_MATCHING_OPTION',
    'cancelTaker',
  ) as SelfMatchingOption,
  siweDomain: optional('DREAMDEX_SIWE_DOMAIN', 'dreamdex.somnia.host'),
  siweUri: optional('DREAMDEX_SIWE_URI', 'https://dreamdex.somnia.host'),
  expireSeconds: Number(optional('DREAMDEX_EXPIRE_SECONDS', '0')),
  cooldownMs: Number(optional('DREAMDEX_COOLDOWN_MS', '20000')),
  dryRun: optional('DREAMDEX_DRY_RUN', 'true') === 'true',
  mmStartingQuoteBalanceQuote: Number(
    optional('DREAMDEX_MM_STARTING_QUOTE_BALANCE_QUOTE', '50'),
  ),
  mmStartingBaseBalance: Number(
    optional('DREAMDEX_MM_STARTING_BASE_BALANCE', '0'),
  ),
  mmQuoteSizeQuote: Number(optional('DREAMDEX_MM_QUOTE_SIZE_QUOTE', '3')),
  mmTargetBaseInventoryQuote: Number(
    optional('DREAMDEX_MM_TARGET_BASE_INVENTORY_QUOTE', '8'),
  ),
  mmMaxBaseInventoryQuote: Number(
    optional('DREAMDEX_MM_MAX_BASE_INVENTORY_QUOTE', '15'),
  ),
  mmMinSpreadBps: Number(optional('DREAMDEX_MM_MIN_SPREAD_BPS', '5')),
  mmTargetHalfSpreadBps: Number(
    optional('DREAMDEX_MM_TARGET_HALF_SPREAD_BPS', '35'),
  ),
  mmInventorySkewBps: Number(optional('DREAMDEX_MM_INVENTORY_SKEW_BPS', '20')),
  mmMaxSessionLossQuote: Number(
    optional('DREAMDEX_MM_MAX_SESSION_LOSS_QUOTE', '3'),
  ),
  rebalanceTradeSizeQuote: Number(
    optional('DREAMDEX_REBALANCE_TRADE_SIZE_QUOTE', '10'),
  ),
  rebalanceTargetBaseQuote: Number(
    optional('DREAMDEX_REBALANCE_TARGET_BASE_QUOTE', '6'),
  ),
  rebalanceTargetToleranceQuote: Number(
    optional('DREAMDEX_REBALANCE_TARGET_TOLERANCE_QUOTE', '2'),
  ),
  rebalanceMaxSpreadBps: Number(
    optional('DREAMDEX_REBALANCE_MAX_SPREAD_BPS', '15'),
  ),
  gridTradeSizeQuote: Number(optional('DREAMDEX_GRID_TRADE_SIZE_QUOTE', '20')),
  gridStepBps: Number(optional('DREAMDEX_GRID_STEP_BPS', '8')),
  gridMaxSpreadBps: Number(optional('DREAMDEX_GRID_MAX_SPREAD_BPS', '25')),
  gridMaxLongQuote: Number(optional('DREAMDEX_GRID_MAX_LONG_QUOTE', '60')),
  gridMaxSessionLossQuote: Number(optional('DREAMDEX_GRID_MAX_SESSION_LOSS_QUOTE', '5')),
  gridStuckTimeoutMs: Number(optional('DREAMDEX_GRID_STUCK_TIMEOUT_MS', String(20 * 60_000))),
  persistenceDir: optional('DREAMDEX_PERSISTENCE_DIR', './data'),
  autoVault: optional('DREAMDEX_AUTO_VAULT', 'false') === 'true',
  vaultGasReserve: optional('DREAMDEX_VAULT_GAS_RESERVE', '0.02'),
  metricsPort: Number(optional('METRICS_PORT', '0')),
} as const;

if (
  Number.isNaN(config.chainId) ||
  Number.isNaN(config.expireSeconds) ||
  Number.isNaN(config.mmStartingQuoteBalanceQuote) ||
  Number.isNaN(config.mmStartingBaseBalance) ||
  Number.isNaN(config.mmQuoteSizeQuote) ||
  Number.isNaN(config.mmTargetBaseInventoryQuote) ||
  Number.isNaN(config.mmMaxBaseInventoryQuote) ||
  Number.isNaN(config.mmMinSpreadBps) ||
  Number.isNaN(config.mmTargetHalfSpreadBps) ||
  Number.isNaN(config.mmInventorySkewBps) ||
  Number.isNaN(config.mmMaxSessionLossQuote) ||
  Number.isNaN(config.rebalanceTradeSizeQuote) ||
  Number.isNaN(config.rebalanceTargetBaseQuote) ||
  Number.isNaN(config.rebalanceTargetToleranceQuote) ||
  Number.isNaN(config.rebalanceMaxSpreadBps) ||
  Number.isNaN(config.gridTradeSizeQuote) ||
  Number.isNaN(config.gridStepBps) ||
  Number.isNaN(config.gridMaxSpreadBps) ||
  Number.isNaN(config.gridMaxLongQuote) ||
  Number.isNaN(config.gridMaxSessionLossQuote) ||
  Number.isNaN(config.gridStuckTimeoutMs) ||
  Number.isNaN(config.metricsPort)
) {
  throw new Error(
    'DreamDEX numeric env vars include invalid numbers. Check thresholds, chain id, expiry, and market-maker settings.',
  );
}

if (
  config.strategy === 'threshold' &&
  (Number.isNaN(config.buyBelowPrice) || Number.isNaN(config.sellAbovePrice))
) {
  throw new Error(
    'Threshold strategy requires numeric DREAMDEX_BUY_BELOW_PRICE and DREAMDEX_SELL_ABOVE_PRICE values.',
  );
}
