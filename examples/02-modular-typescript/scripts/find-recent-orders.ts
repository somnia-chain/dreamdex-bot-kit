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

const POOL_ADDR = "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b".toLowerCase();
// Empirically verified on-chain topic — see safe-broadcast.ts + Obs-006
const ORDER_PLACED_TOPIC =
  "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");
  const me = ctx.wallet.address.toLowerCase();

  const currentBlock = await ctx.provider.getBlockNumber();
  const lookback = Number(process.argv[2] ?? "10000");
  const chunkSize = 1000;
  const startBlock = currentBlock - lookback;

  logger.info(
    { from: startBlock, to: currentBlock, chunkSize, address: me },
    "Scanning OrderPlaced logs for wallet (chunked)…",
  );

  const logs: ethers.Log[] = [];
  for (let cur = startBlock; cur <= currentBlock; cur += chunkSize) {
    const to = Math.min(cur + chunkSize - 1, currentBlock);
    try {
      const chunk = await ctx.provider.getLogs({
        address: POOL_ADDR,
        topics: [ORDER_PLACED_TOPIC],
        fromBlock: cur,
        toBlock: to,
      });
      // Filter to only events from our wallet's txs
      const ours: ethers.Log[] = [];
      for (const log of chunk) {
        const tx = await ctx.provider.getTransaction(log.transactionHash);
        if (tx?.from?.toLowerCase() === me) {
          ours.push(log);
        }
      }
      if (ours.length > 0) {
        logger.info({ from: cur, to, found: ours.length }, "Chunk has our events");
        logs.push(...ours);
      }
    } catch (err) {
      logger.warn({ from: cur, to, err: (err as Error).message }, "Chunk failed");
    }
  }
  logger.info({ count: logs.length }, "OrderPlaced events found");

  const orderIds: bigint[] = [];
  for (const log of logs) {
    const id = BigInt(log.topics[1] ?? "0x0");
    orderIds.push(id);
    logger.info(
      { orderId: id.toString(), block: log.blockNumber, tx: log.transactionHash },
      "Found order",
    );
  }

  if (orderIds.length === 0) {
    logger.info("No orders to cancel");
    return;
  }

  const handle = await getPoolHandle("USDC.e:USDso");
  for (const id of orderIds) {
    try {
      const tx = await safeCancelOrder(handle, id);
      logger.info({ orderId: id.toString(), tx }, "Cancelled");
    } catch (err) {
      logger.error(
        { orderId: id.toString(), err: (err as Error).message },
        "Cancel failed (maybe already filled/cancelled)",
      );
    }
  }
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
