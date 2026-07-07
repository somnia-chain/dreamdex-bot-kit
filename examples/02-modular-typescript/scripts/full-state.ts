/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { getChainContext } from "../src/utils/signer.js";
import { getPoolHandle, getErc20 } from "../src/dex/contracts.js";
import { getToken } from "../src/config/tokens.js";
import { logger } from "../src/utils/logger.js";
import { fromRaw } from "../src/utils/decimals.js";

async function main(): Promise<void> {
  const ctx = await getChainContext({ requireSigner: true });
  if (!ctx.wallet) throw new Error("Signer required");
  const me = ctx.wallet.address;

  const native = await ctx.provider.getBalance(me);
  logger.info({ native: fromRaw(native, 18) + " " + ctx.network.nativeSymbol }, "Wallet native");

  for (const sym of ["USDso", "USDC.e"]) {
    try {
      const tok = getToken(ctx.network.name, sym);
      const erc = await getErc20(tok.address);
      const bal: bigint = await erc.balanceOf(me);
      logger.info(
        { token: sym, decimals: tok.decimals, raw: bal.toString(), formatted: fromRaw(bal, tok.decimals) },
        `Wallet ${sym}`,
      );
    } catch (err) {
      logger.warn({ sym, err: (err as Error).message }, `Wallet ${sym} probe failed`);
    }
  }

  const handle = await getPoolHandle("USDC.e:USDso");
  const usdsoVault: bigint = await handle.readonly.getWithdrawableBalance(me, handle.quoteToken.address);
  const usdceVault: bigint = await handle.readonly.getWithdrawableBalance(me, handle.baseToken.address);
  logger.info(
    {
      USDso_free: fromRaw(usdsoVault, 18),
      "USDC.e_free": fromRaw(usdceVault, 6),
    },
    "Vault free balances",
  );

  const nonce = await ctx.provider.getTransactionCount(me);
  logger.info({ nonce, network: ctx.network.name }, "Wallet nonce");
}

main().catch((err) => {
  logger.fatal({ err });
  process.exit(1);
});
