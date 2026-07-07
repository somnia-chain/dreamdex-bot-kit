/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { ethers } from "ethers";
import { getActiveNetwork, type NetworkConfig } from "../config/network.js";
import { logger } from "./logger.js";

export interface ChainContext {
  network: NetworkConfig;
  provider: ethers.JsonRpcProvider;
  wallet?: ethers.Wallet;
  address?: string;
}

let cached: ChainContext | undefined;

export async function getChainContext(opts: { requireSigner?: boolean } = {}): Promise<ChainContext> {
  if (cached) return cached;

  const network = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(network.rpc, {
    chainId: network.chainId,
    name: network.name,
  });

  const observed = await provider.getNetwork();
  if (Number(observed.chainId) !== network.chainId) {
    throw new Error(
      `RPC chainId mismatch: expected ${network.chainId}, got ${observed.chainId}`,
    );
  }

  let privKey = process.env.PRIVATE_KEY?.trim();
  let expectedAddr: string | undefined = process.env.WALLET_ADDRESS?.toLowerCase();
  let walletRole: string | undefined;

  const fleetIdx = process.env.FLEET_WALLET_INDEX;
  const fleetFile = process.env.FLEET_FILE ?? "data/bot-wallets.json";
  if (fleetIdx !== undefined && fleetIdx !== "") {
    if (!existsSync(fleetFile)) {
      throw new Error(`FLEET_WALLET_INDEX=${fleetIdx} but ${fleetFile} not found`);
    }
    const fleet = JSON.parse(readFileSync(fleetFile, "utf-8")) as {
      wallets: Array<{ id: number; address: string; privateKey: string; role: string }>;
    };
    const idx = Number(fleetIdx);
    const entry = fleet.wallets[idx];
    if (!entry) {
      throw new Error(`FLEET_WALLET_INDEX=${idx} out of range (fleet size ${fleet.wallets.length})`);
    }
    privKey = entry.privateKey;
    expectedAddr = entry.address.toLowerCase();
    walletRole = entry.role;
    logger.info(
      { idx, address: entry.address, role: entry.role },
      "Loaded wallet from fleet file",
    );
  }

  if (!privKey) {
    if (opts.requireSigner) {
      throw new Error(
        "PRIVATE_KEY is empty — cannot create signer. Set it in .env to perform write operations.",
      );
    }
    logger.warn(
      "PRIVATE_KEY not set — read-only context (no signer attached)",
    );
    cached = { network, provider };
    return cached;
  }

  const wallet = new ethers.Wallet(privKey, provider);
  if (expectedAddr && wallet.address.toLowerCase() !== expectedAddr) {
    throw new Error(
      `Wallet address mismatch: derived ${wallet.address} but expected ${expectedAddr}`,
    );
  }

  logger.info(
    { address: wallet.address, chainId: network.chainId, role: walletRole },
    "Signer initialized",
  );

  cached = { network, provider, wallet, address: wallet.address };
  return cached;
}

export function resetChainContext(): void {
  cached = undefined;
}
