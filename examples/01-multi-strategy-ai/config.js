/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '.env') });

export const CONFIG = {
  PRIVATE_KEY: process.env.DREAMDEX_PRIVATE_KEY || '',
  WALLET_ADDRESS: (process.env.DREAMDEX_WALLET_ADDRESS || '').toLowerCase(),
  RPC_URL: process.env.RPC_URL || 'https://dream-rpc.somnia.network',
  API_URL: process.env.API_URL || 'https://stg.api.dreamdex.io',
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '50312', 10),
  MARKET_SYMBOL: 'WETH:USDso',

  INITIAL_DEPOSIT_USDSO: parseFloat(process.env.INITIAL_DEPOSIT_USDSO || '50'),
  MAX_RISK_PERCENT: parseFloat(process.env.MAX_RISK_PERCENT || '0.15'),
  MIN_RISK_PERCENT: 0.10,
  MAX_LOSS_PERCENT: 0.50,
  LOOP_INTERVAL_MS: parseInt(process.env.LOOP_INTERVAL_MINUTES || '2', 10) * 60 * 1000,

  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || '',
  COINGECKO_BASE_URL: 'https://api.coingecko.com/api/v3',
  COINGECKO_COINS: 'bitcoin,ethereum',
  COINGECKO_CURRENCY: 'usd',
  COINGECKO_ENABLED: true,

  OPCODE_HOSTNAME: '127.0.0.1',
  OPCODE_PORT: 3333,
  OPCODE_START_TIMEOUT: 60000,
  OPCODE_SESSION_ROTATE: 50,
  OPCODE_PROVIDER: process.env.OPCODE_PROVIDER || 'anthropic',
  OPCODE_API_KEY: process.env.OPCODE_API_KEY || '',

  DATA_DIR: path.resolve(__dirname, 'data'),
  BASE_DECIMALS: 18,
};
