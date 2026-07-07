/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle } from "../src/dex/contracts.js";
import { safeCancelOrder } from "../src/dex/safe-broadcast.js";
import { logger } from "../src/utils/logger.js";

const POOL_SYMBOL = process.argv[2] ?? "USDC.e:USDso";
const ORDER_IDS = process.argv.slice(3);

async function main(): Promise<void> {
  if (ORDER_IDS.length === 0) {
    throw new Error("Usage: cancel-by-id.ts <pool-symbol> <orderId...>");
  }
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const handle = await getPoolHandle(POOL_SYMBOL);
  for (const idStr of ORDER_IDS) {
    const id = BigInt(idStr);
    try {
      const tx = await safeCancelOrder(handle, id);
      logger.info({ orderId: idStr, tx }, "Cancelled");
    } catch (err) {
      logger.error({ orderId: idStr, err: (err as Error).message }, "Cancel failed");
    }
  }
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
