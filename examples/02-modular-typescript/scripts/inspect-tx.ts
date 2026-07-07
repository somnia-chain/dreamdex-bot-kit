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

const ORDER_PLACED_TOPIC =
  "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";

const TX_HASH = process.argv[2];

async function main(): Promise<void> {
  if (!TX_HASH) throw new Error("Usage: inspect-tx <hash>");
  const ctx = await getChainContext();
  const receipt = await ctx.provider.getTransactionReceipt(TX_HASH);
  if (!receipt) throw new Error("No receipt");

  logger.info({ status: receipt.status, gas: receipt.gasUsed.toString(), logCount: receipt.logs.length }, "Receipt");
  for (const [i, log] of receipt.logs.entries()) {
    const isOrderPlaced = log.topics[0] === ORDER_PLACED_TOPIC;
    const orderId = log.topics[1] ? BigInt(log.topics[1]).toString() : "n/a";
    logger.info({
      i,
      address: log.address,
      topic0: log.topics[0],
      topic1: log.topics[1],
      orderIdDecimal: isOrderPlaced ? orderId : undefined,
      isOrderPlaced,
      dataLen: log.data.length,
    }, `Log ${i}`);
  }
}

main().catch((err) => { logger.fatal({ err }); process.exit(1); });
