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
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

let previousPrice = 0;

function timestamp() {
  return new Date().toISOString();
}

async function fetchPrice() {
  const res = await httpRequest('GET', `/v0/orderbooks?symbols=${PAIR}`);
  if (res.status !== 200 || !res.body) return null;
  const obs = res.body.orderbooks || [res.body];
  const ob = obs[0] || {};
  const bids = ob.bids || [];
  const asks = ob.asks || [];
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = parseFloat(bids[0].price || bids[0][0] || 0);
  const ask = parseFloat(asks[0].price || asks[0][0] || 0);
  return { bid, ask, mid: (bid + ask) / 2 };
}

setInterval(async () => {
  try {
    const price = await fetchPrice();
    if (!price) return;

    const { bid, ask, mid } = price;
    let color = WHITE;
    let arrow = '→';
    let change = '-';

    if (previousPrice > 0) {
      const diff = mid - previousPrice;
      if (diff > 0) { color = GREEN; arrow = '↑'; change = `+${diff.toFixed(4)}`; }
      else if (diff < 0) { color = RED; arrow = '↓'; change = diff.toFixed(4); }
      else { arrow = '→'; change = '0.0000'; }
    }

    console.log(
      `${GRAY}[${timestamp()}]${RESET} ${color}${arrow}${RESET} ` +
      `${GRAY}Bid:${RESET} ${color}${bid.toFixed(4)}${RESET} ` +
      `${GRAY}Ask:${RESET} ${color}${ask.toFixed(4)}${RESET} ` +
      `${GRAY}Mid:${RESET} ${color}${mid.toFixed(4)}${RESET} ` +
      `(${color}${change}${RESET})`
    );

    previousPrice = mid;
  } catch (err) {
    console.log(`${RED}[${timestamp()}] Error: ${err.message}${RESET}`);
  }
}, 1000);

console.log(`${GREEN}=== Price Monitor Started ===${RESET}`);
console.log(`${GRAY}Pair: ${PAIR} | Interval: 1000ms${RESET}`);
console.log(`${GREEN}↑ hijau = naik | ${RED}↓ merah = turun | ${WHITE}→ putih = tetap${RESET}\n`);
