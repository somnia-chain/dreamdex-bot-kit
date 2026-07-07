/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import { getChainContext } from "../src/utils/signer.js";
import { getToken } from "../src/config/tokens.js";
import { logger } from "../src/utils/logger.js";

interface BotWallet {
  id: number;
  address: string;
  privateKey: string;
  role: string;
}

const FLEET_FILE = process.argv[2] ?? "data/bot-wallets.json";
const USDSO_PER_WALLET = process.argv[3] ?? "2";
const SOMI_GAS_PER_WALLET = process.argv[4] ?? "0.2";

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const fleet = JSON.parse(await readFile(FLEET_FILE, "utf-8")) as {
    wallets: BotWallet[];
  };

  const usdsoToken = getToken(ctx.network.name, "USDso");
  const usdsoAmount = ethers.parseUnits(USDSO_PER_WALLET, usdsoToken.decimals);
  const somiAmount = ethers.parseEther(SOMI_GAS_PER_WALLET);

  logger.info(
    {
      walletsCount: fleet.wallets.length,
      usdsoPerWallet: USDSO_PER_WALLET,
      somiPerWallet: SOMI_GAS_PER_WALLET,
      totalUsdso: (Number(USDSO_PER_WALLET) * fleet.wallets.length).toFixed(2),
      totalSomi: (Number(SOMI_GAS_PER_WALLET) * fleet.wallets.length).toFixed(2),
    },
    "Funding fleet — sending from registered wallet",
  );

  const usdso = new ethers.Contract(
    usdsoToken.address,
    ["function transfer(address to, uint256 amount) returns (bool)"],
    ctx.wallet,
  );

  for (const w of fleet.wallets) {
    logger.info({ id: w.id, address: w.address, role: w.role }, "Funding");

    try {
      const usdsoTx = await (usdso.transfer as ethers.BaseContractMethod<
        [string, bigint],
        boolean,
        ethers.ContractTransactionResponse
      >)(w.address, usdsoAmount);
      const usdsoReceipt = await usdsoTx.wait();
      logger.info(
        { id: w.id, txHash: usdsoReceipt?.hash },
        `Sent ${USDSO_PER_WALLET} USDso`,
      );
    } catch (err) {
      logger.error({ id: w.id, err: (err as Error).message }, "USDso transfer failed");
      continue;
    }

    try {
      const somiTx = await ctx.wallet.sendTransaction({
        to: w.address,
        value: somiAmount,
      });
      const somiReceipt = await somiTx.wait();
      logger.info(
        { id: w.id, txHash: somiReceipt?.hash },
        `Sent ${SOMI_GAS_PER_WALLET} native SOMI`,
      );
    } catch (err) {
      logger.error({ id: w.id, err: (err as Error).message }, "SOMI transfer failed");
    }
  }

  logger.info("Fleet funding complete");
}

main().catch((err) => {
  logger.fatal({ err: err.message ?? err });
  process.exit(1);
});
