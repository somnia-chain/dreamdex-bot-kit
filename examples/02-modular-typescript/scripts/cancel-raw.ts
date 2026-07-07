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
import { logger } from "../src/utils/logger.js";

const POOL_SYMBOL = process.argv[2] ?? "USDC.e:USDso";
const ORDER_IDS = process.argv.slice(3);

async function main(): Promise<void> {
  if (ORDER_IDS.length === 0) throw new Error("Usage: cancel-raw <pool> <orderId...>");
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");

  const handle = await getPoolHandle(POOL_SYMBOL);
  for (const idStr of ORDER_IDS) {
    const id = BigInt(idStr);
    try {
      logger.info({ orderId: idStr }, "Broadcasting cancelOrder (no sim)");
      const tx = await handle.contract.cancelOrder(id);
      const receipt = await tx.wait();
      logger.info({ orderId: idStr, txHash: receipt?.hash, status: receipt?.status }, "Result");
    } catch (err) {
      logger.error({ orderId: idStr, err: (err as Error).message }, "Cancel broadcast failed");
    }
  }
}

main().catch((err) => { logger.fatal({ err }); process.exit(1); });
