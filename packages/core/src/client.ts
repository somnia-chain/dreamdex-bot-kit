/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Chain clients. One place to build the viem public (read) and wallet (sign)
// clients for the active network from a private key. Don't construct clients
// elsewhere — pass this ChainContext around.

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetwork, toViemChain, type NetworkConfig } from "./config/networks.js";

export interface ChainContext {
  net: NetworkConfig;
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /**
   * Split-key / session-key mode. When set (via OWNER_ADDRESS), `account` is the
   * OPERATOR key and orders are placed on behalf of this owner via placeOrderFor.
   * The operator can never move funds. See docs/session-keys.md.
   */
  owner?: `0x${string}`;
}

export function createChainContext(privateKey?: string): ChainContext {
  const net = getNetwork();
  const key = privateKey ?? process.env.PRIVATE_KEY;
  if (!key) throw new Error("Set PRIVATE_KEY (env) or pass one to createChainContext().");

  const account = privateKeyToAccount(key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`));
  const chain = toViemChain(net);

  const publicClient = createPublicClient({ chain, transport: http(net.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(net.rpcUrl) });

  const ownerRaw = process.env.OWNER_ADDRESS;
  const owner = ownerRaw ? (ownerRaw as `0x${string}`) : undefined;

  return { net, account, publicClient, walletClient, owner };
}
