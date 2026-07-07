/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { CONFIG } from '../config.js';
import { httpRequest } from './http.js';
import { log } from './logger.js';

let jwtToken = null;
let jwtExpiry = null;

export function getCachedAuthHeaders() {
  if (jwtToken && jwtExpiry && Date.now() < jwtExpiry - 300000) {
    return { Authorization: `Bearer ${jwtToken}` };
  }
  return null;
}

export async function getAuthHeaders(walletClient, account) {
  const cached = getCachedAuthHeaders();
  if (cached) return cached;

  log('info', 'auth', 'Authenticating with DreamDEX via SIWE...');

  const nonceRes = await httpRequest('GET', '/v0/auth/nonce');
  if (nonceRes.status !== 200 || !nonceRes.body.nonce) {
    throw new Error(`Failed to fetch nonce: ${nonceRes.status}`);
  }

  const nonce = nonceRes.body.nonce;
  const domain = new URL(CONFIG.API_URL).hostname;
  const issuedAt = new Date().toISOString();
  const checksummed = account.address;

  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${checksummed}\n\n` +
    `Sign in to dreamDEX\n\n` +
    `URI: ${CONFIG.API_URL}\n` +
    `Version: 1\n` +
    `Chain ID: ${CONFIG.CHAIN_ID}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`;

  const signature = await walletClient.signMessage({ message, account });

  const loginRes = await httpRequest('POST', '/v0/auth/login', {}, {
    message,
    signature,
  });

  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`Auth login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  jwtToken = loginRes.body.token;
  jwtExpiry = new Date(loginRes.body.expiresAt).getTime();

  log('success', 'auth', `Authenticated. Token expires: ${new Date(jwtExpiry).toLocaleTimeString()}`);
  return { Authorization: `Bearer ${jwtToken}` };
}

export function clearAuth() {
  jwtToken = null;
  jwtExpiry = null;
}
