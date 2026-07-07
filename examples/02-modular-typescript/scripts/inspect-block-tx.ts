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

const POOL_ADDR = "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b".toLowerCase();

async function main(): Promise<void> {
  const ctx = await getChainContext();
  const me = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86".toLowerCase();

  const blockNumbers = [317034820, 317035239];
  for (const bn of blockNumbers) {
    const block = await ctx.provider.getBlock(bn, true);
    if (!block) continue;
    for (const tx of block.prefetchedTransactions) {
      if (tx.from?.toLowerCase() !== me) continue;
      logger.info({ block: bn, hash: tx.hash, to: tx.to, value: tx.value.toString() }, "Our tx");

      const receipt = await ctx.provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;
      logger.info({ status: receipt.status, gas: receipt.gasUsed.toString(), logs: receipt.logs.length }, "Receipt");
      for (const [i, log] of receipt.logs.entries()) {
        logger.info(
          {
            i,
            address: log.address,
            isPool: log.address.toLowerCase() === POOL_ADDR,
            topic0: log.topics[0],
            topic1: log.topics[1],
            topic2: log.topics[2],
            dataLen: log.data.length,
          },
          "Log",
        );
      }
    }
  }
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
