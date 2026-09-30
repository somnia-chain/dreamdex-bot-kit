/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Take an EIP-7702 delegation back off the wallet.
//
// A delegation is not scoped to one transaction: once installed, the account
// carries the implementation's code until the account signs a new authorization.
// Authorizing the zero address is how you clear it. `npm run start` does this at
// the end of every run; `npm run clear -w batch-7702` (src/clear.ts) does it for
// a wallet that ran an older version, or a run that was interrupted.

import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

type Ctx = ReturnType<typeof createChainContext>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** The 7702 marker: a delegated account's code is `0xef0100 || implementation`. */
export function delegatedImplementation(code: string | undefined): `0x${string}` | null {
  if (!code || !code.startsWith("0xef0100")) return null;
  return `0x${code.slice(8)}` as `0x${string}`;
}

/**
 * Clear the delegation on `ctx.account`, if it has one, and verify the account
 * is code-free afterwards. Safe to call when there is nothing to clear.
 */
export async function clearDelegation(ctx: Ctx): Promise<void> {
  const address = ctx.account.address;
  const before = await ctx.publicClient.getCode({ address });
  const impl = delegatedImplementation(before);
  if (!impl) {
    console.log(`[7702] ${address} carries no delegation, nothing to clear`);
    return;
  }

  const authorization = await ctx.walletClient.signAuthorization({
    account: ctx.account,
    contractAddress: ZERO_ADDRESS,
    executor: "self",
  });
  const hash = await ctx.walletClient.sendTransaction({
    account: ctx.account,
    chain: ctx.walletClient.chain,
    to: address,
    authorizationList: [authorization],
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });

  const after = await ctx.publicClient.getCode({ address });
  if (delegatedImplementation(after)) {
    throw new Error(`[7702] delegation still present on ${address} after ${hash}`);
  }
  console.log(`[7702] cleared delegation ${impl} from ${address} (tx ${hash})`);
}

