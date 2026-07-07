/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle } from "../src/dex/contracts.js";
import { safeCancelOrder } from "../src/dex/safe-broadcast.js";
import { logger } from "../src/utils/logger.js";

// Empirically verified on-chain — see safe-broadcast.ts + Obs-006
const ORDER_PLACED_TOPIC =
  "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";
const TX_HASHES = process.argv.slice(2);

async function main(): Promise<void> {
  if (TX_HASHES.length === 0) {
    throw new Error("Provide one or more tx hashes as args");
  }
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");
  const handle = await getPoolHandle("USDC.e:USDso");

  const orderIds: bigint[] = [];
  for (const hash of TX_HASHES) {
    const r = await ctx.provider.getTransactionReceipt(hash);
    if (!r) {
      logger.warn({ hash }, "No receipt");
      continue;
    }
    for (const log of r.logs) {
      if (log.topics[0] === ORDER_PLACED_TOPIC) {
        const orderId = BigInt(log.topics[1] ?? "0x0");
        orderIds.push(orderId);
        logger.info(
          { hash, orderId: orderId.toString(), poolAddr: log.address },
          "Found OrderPlaced event",
        );
      }
    }
  }

  logger.info({ count: orderIds.length }, "Total open orders identified");

  for (const id of orderIds) {
    try {
      const tx = await safeCancelOrder(handle, id);
      logger.info({ orderId: id.toString(), tx }, "Cancelled");
    } catch (err) {
      logger.error({ orderId: id.toString(), err: (err as Error).message }, "Cancel failed");
    }
  }
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
