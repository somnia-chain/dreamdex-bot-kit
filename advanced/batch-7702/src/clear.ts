/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Remediation entry point: clear a 7702 delegation left on the wallet in
// PRIVATE_KEY. Prints what it found and what it did.
//
//   npm run clear -w batch-7702

import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { clearDelegation } from "./clear-delegation.js";

async function main(): Promise<void> {
  const ctx = createChainContext();
  await clearDelegation(ctx);
}

main().catch((err) => {
  console.error("[7702] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
