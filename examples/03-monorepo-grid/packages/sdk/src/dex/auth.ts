/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Wallet } from 'ethers';

export function buildSiweMessage(
  address: string,
  nonce: string,
  issuedAt: string,
  chainId: number,
  domain: string,
  uri: string,
): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to dreamDEX',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export async function signSiweMessage(
  wallet: Wallet,
  nonce: string,
  chainId: number,
  domain: string,
  uri: string,
): Promise<string> {
  const issuedAt = new Date().toISOString();
  const message = buildSiweMessage(
    wallet.address,
    nonce,
    issuedAt,
    chainId,
    domain,
    uri,
  );
  const signature = await wallet.signMessage(message);
  return JSON.stringify({ message, signature });
}
