/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { getChainContext } from "../src/utils/signer.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const ctx = await getChainContext();
  if (!ctx.wallet) throw new Error("Signer required");
  const nonce = await ctx.provider.getTransactionCount(ctx.wallet.address);
  const block = await ctx.provider.getBlockNumber();
  logger.info(
    {
      address: ctx.wallet.address,
      network: ctx.network.name,
      chainId: ctx.network.chainId,
      nonce,
      currentBlock: block,
    },
    "Wallet info",
  );
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
