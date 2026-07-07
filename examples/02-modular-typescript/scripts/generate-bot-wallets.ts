/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { logger } from "../src/utils/logger.js";

const COUNT = Number(process.argv[2] ?? "5");
const OUT = process.argv[3] ?? "data/bot-wallets.json";

export type FleetRole =
  | "mm-usdce-tight"
  | "mm-usdce-mid"
  | "mm-somi"
  | "momentum-somi"
  | "reserve";

interface BotWallet {
  id: number;
  address: string;
  privateKey: string;
  role: FleetRole;
}

const ROLES: FleetRole[] = [
  "mm-usdce-tight",
  "mm-usdce-mid",
  "mm-somi",
  "momentum-somi",
  "reserve",
];

async function main(): Promise<void> {
  if (existsSync(OUT)) {
    throw new Error(
      `${OUT} already exists — refusing to overwrite. Move/delete it first if you really want to regenerate.`,
    );
  }
  await mkdir("data", { recursive: true });

  const wallets: BotWallet[] = [];
  for (let i = 0; i < COUNT; i += 1) {
    const w = ethers.Wallet.createRandom();
    wallets.push({
      id: i,
      address: w.address,
      privateKey: w.privateKey,
      role: ROLES[i % ROLES.length] ?? "reserve",
    });
  }

  const payload = {
    createdAt: new Date().toISOString(),
    network: "mainnet",
    parentWallet: "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86",
    wallets,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2), { mode: 0o600 });
  logger.info(
    { count: wallets.length, path: OUT },
    "Bot wallets generated. Keep this file PRIVATE.",
  );
  for (const w of wallets) {
    logger.info({ id: w.id, address: w.address, role: w.role }, "Wallet");
  }
}

main().catch((err) => {
  logger.fatal({ err: err.message ?? err });
  process.exit(1);
});
