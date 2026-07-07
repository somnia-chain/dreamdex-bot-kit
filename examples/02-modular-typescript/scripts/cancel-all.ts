/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle, readOwnOpenOrders } from "../src/dex/contracts.js";
import { safeCancelOrder } from "../src/dex/safe-broadcast.js";
import { logger } from "../src/utils/logger.js";

const POOL_SYMBOL = process.argv[2] ?? "USDC.e:USDso";

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const handle = await getPoolHandle(POOL_SYMBOL);
  const openIds = await readOwnOpenOrders(handle, ctx.wallet.address);
  logger.info(
    { pool: POOL_SYMBOL, count: openIds.length, ids: openIds.map(String) },
    "Open orders on pool",
  );

  for (const id of openIds) {
    try {
      const tx = await safeCancelOrder(handle, id);
      logger.info({ id: id.toString(), tx }, "Cancelled");
    } catch (err) {
      logger.error({ id: id.toString(), err: (err as Error).message }, "Cancel failed");
    }
  }

  const remaining = await readOwnOpenOrders(handle, ctx.wallet.address);
  logger.info({ remaining: remaining.length }, "After cancel-all");
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
