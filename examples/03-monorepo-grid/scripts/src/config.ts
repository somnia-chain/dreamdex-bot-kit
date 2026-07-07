/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import 'dotenv/config';
import { Wallet } from 'ethers';
import type { FundingSource, OrderType, SelfMatchingOption } from '@trading/sdk';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const optional = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;

const privateKey = required('DREAMDEX_PRIVATE_KEY');
const wallet = new Wallet(privateKey);
const envName = optional('DREAMDEX_ENV', 'mainnet');

export const config = {
  envName,
  baseUrl: optional(
    'DREAMDEX_BASE_URL',
    envName === 'staging' ? 'https://stg.api.dreamdex.io' : 'https://api.dreamdex.io',
  ),
  chainId: Number(optional('DREAMDEX_CHAIN_ID', envName === 'staging' ? '50312' : '5031')),
  rpcUrl: required('DREAMDEX_RPC_URL'),
  privateKey,
  walletAddress: wallet.address,
  symbol: required('DREAMDEX_SYMBOL'),
  orderAmount: required('DREAMDEX_ORDER_AMOUNT'),
  fundingSource: optional('DREAMDEX_FUNDING_SOURCE', 'wallet') as FundingSource,
  orderType: optional('DREAMDEX_ORDER_TYPE', 'immediateOrCancel') as OrderType,
  selfMatchingOption: optional('DREAMDEX_SELF_MATCHING_OPTION', 'cancelTaker') as SelfMatchingOption,
  siweDomain: optional('DREAMDEX_SIWE_DOMAIN', 'dreamdex.somnia.host'),
  siweUri: optional('DREAMDEX_SIWE_URI', 'https://dreamdex.somnia.host'),
  expireSeconds: Number(optional('DREAMDEX_EXPIRE_SECONDS', '0')),
  dryRun: optional('DREAMDEX_DRY_RUN', 'true') === 'true',
  persistenceDir: optional('DREAMDEX_PERSISTENCE_DIR', './data'),
  strategy: optional('DREAMDEX_STRATEGY', 'threshold'),
  executionMode: optional('DREAMDEX_EXECUTION_MODE', 'http'),
} as const;
