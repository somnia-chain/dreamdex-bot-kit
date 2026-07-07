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
import { httpRequest } from './utils/http.js';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PAIR = CONFIG.MARKET_SYMBOL;
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const WHITE = '\x1b[37m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

function timestamp() {
  return new Date().toISOString();
}

async function fetchOrderbook() {
  const res = await httpRequest('GET', `/v0/orderbooks?symbols=${PAIR}`);
  if (res.status !== 200 || !res.body) return null;
  const obs = res.body.orderbooks || [res.body];
  const ob = obs[0] || {};
  const bids = ob.bids || [];
  const asks = ob.asks || [];
  if (bids.length === 0 || asks.length === 0) return null;
  return {
    bid: parseFloat(bids[0].price || bids[0][0] || 0),
    ask: parseFloat(asks[0].price || asks[0][0] || 0),
  };
}

setInterval(async () => {
  try {
    const ob = await fetchOrderbook();
    if (!ob) return;

    const spread = ob.ask - ob.bid;
    const spreadPct = (spread / ob.ask) * 100;
    let color = WHITE;
    if (spread >= 0.43) color = RED;
    else if (spread >= 0.41) color = YELLOW;
    else color = GREEN;

    console.log(
      `${GRAY}[${timestamp()}]${RESET} ` +
      `${color}Bid:${RESET} ${ob.bid.toFixed(4)} ${color}Ask:${RESET} ${ob.ask.toFixed(4)} ` +
      `${color}Spread: ${spread.toFixed(4)} (${spreadPct.toFixed(3)}%)${RESET}`
    );
  } catch (err) {
    console.log(`${GRAY}[${timestamp()}]${RESET} ${RED}Error: ${err.message}${RESET}`);
  }
}, 100);

console.log(`${GREEN}=== Spread Monitor Started ===${RESET}`);
console.log(`${GRAY}Pair: ${PAIR} | Interval: 100ms${RESET}`);
console.log(`${GREEN}🟢 < 0.41  ${YELLOW}🟡 0.41-0.43  ${RED}🔴 > 0.43${RESET}\n`);
