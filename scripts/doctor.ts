/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Read-only setup check: prints your wallet address, gas + token balances, and
// top of book for every market on the active network. Sends no transactions.
//
//   NETWORK=testnet npx tsx scripts/doctor.ts
//
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const { createChainContext, Pool, MARKETS, ERC20_ABI, NATIVE_SENTINEL, formatUnits } = await import("@dreamdex-bot-kit/core").then(async (m) => ({
  ...m,
  formatUnits: (await import("viem")).formatUnits,
}));

async function main(): Promise<void> {
  const ctx = createChainContext();
  const native = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`\nnetwork : ${ctx.net.name} (chain ${ctx.net.chainId})`);
  console.log(`wallet  : ${ctx.account.address}`);
  console.log(`gas     : ${formatUnits(native, 18)} ${ctx.net.nativeSymbol}\n`);

  for (const symbol of Object.keys(MARKETS[ctx.net.name])) {
    try {
      const pool = await Pool.load(ctx, symbol);
      const { bestBid, bestAsk } = await pool.topOfBook();
      const quoteBal = await ctx.publicClient.readContract({
        address: pool.params.quoteToken, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.account.address],
      });
      let baseBal: bigint;
      if (pool.baseIsNative) baseBal = native;
      else baseBal = await ctx.publicClient.readContract({
        address: pool.params.baseToken, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.account.address],
      });
      const bidS = bestBid !== undefined ? bestBid.toFixed(6) : "—";
      const askS = bestAsk !== undefined ? bestAsk.toFixed(6) : "—";
      console.log(
        `${symbol.padEnd(14)} book[bid=${bidS} ask=${askS}] ` +
        `tick=${pool.tick} lot=${pool.lot} minQty=${pool.minQty} | ` +
        `wallet base=${Number(formatUnits(baseBal, pool.baseDecimals)).toFixed(6)} ` +
        `quote(USDso)=${Number(formatUnits(quoteBal, pool.quoteDecimals)).toFixed(4)} ` +
        `vaultBase=${(await pool.vaultBase()).toFixed(6)}`,
      );
    } catch (err) {
      console.log(`${symbol.padEnd(14)} ERROR: ${(err as Error).message.slice(0, 90)}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
