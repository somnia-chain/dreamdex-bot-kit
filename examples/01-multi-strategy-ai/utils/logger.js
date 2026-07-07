/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

const RESET = '\x1b[0m';
const COLORS = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  banner: '\x1b[35m',
  ai: '\x1b[94m',
  trade: '\x1b[92m',
  cycle: '\x1b[90m',
  alert: '\x1b[41m\x1b[37m',
};

function timestamp() {
  return new Date().toISOString();
}

export function log(level, tag, message) {
  const color = COLORS[level] || COLORS.info;
  console.log(`${color}[${timestamp()}] [${tag.toUpperCase()}] ${message}${RESET}`);
}

export function alert(message) {
  const color = COLORS.alert;
  console.log(`\n${color}${'='.repeat(60)}${RESET}`);
  console.log(`${color}  🚨 CIRCUIT BREAKER ALERT  ${RESET}`);
  console.log(`${color}  ${message}  ${RESET}`);
  console.log(`${color}${'='.repeat(60)}${RESET}\n`);
}

export function success(message) {
  console.log(`${COLORS.success}[${timestamp()}] [SUCCESS] ${message}${RESET}`);
}

export function error(message) {
  console.log(`${COLORS.error}[${timestamp()}] [ERROR] ${message}${RESET}`);
}

export function separator() {
  console.log(`${COLORS.cycle}${'-'.repeat(60)}${RESET}`);
}
