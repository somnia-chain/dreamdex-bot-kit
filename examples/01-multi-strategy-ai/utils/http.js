/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { CONFIG } from '../config.js';

export async function httpRequest(method, path, headers = {}, data = null) {
  const url = `${CONFIG.API_URL}${path}`;
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  };

  if (data !== null) {
    options.body = JSON.stringify(data);
    options.headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: err.message } };
  }
}

export async function httpRequestWithRetry(method, path, headers, data, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await httpRequest(method, path, headers, data);
    if (result.status >= 200 && result.status < 500) {
      return result;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  return await httpRequest(method, path, headers, data);
}
