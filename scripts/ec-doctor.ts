/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Read-only EC preflight: venue scope, live markets, books, and wallet balances.
// Sends no transactions.
//
//   NETWORK=testnet npm run ec:doctor

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const {
  createExchange,
  loadConfig,
  shutdown,
  resolveVenue,
  activeMarkets,
  marketOnchain,
  isTradable,
  outcomeSymbols,
  snapshot,
  MARKET_STATUS,
  toHuman,
} = await import("@dreamdex-bot-kit/ec-core");

const statusName = (s: number) =>
  Object.keys(MARKET_STATUS).find((k) => MARKET_STATUS[k as keyof typeof MARKET_STATUS] === s) ?? String(s);

function shortVenue(scope: { venueId?: string; operatorId?: number }): string {
  if (scope.venueId) return scope.venueId.slice(0, 10) + "…";
  if (scope.operatorId !== undefined) return `operatorId=${scope.operatorId}`;
  return "(all binary on deployment)";
}

async function printWallet(
  label: string,
  pkEnv: string | undefined,
  ctx: Awaited<ReturnType<typeof createExchange>>,
): Promise<void> {
  const pk = (pkEnv ?? "").trim();
  if (!pk) {
    console.log(`${label.padEnd(12)} (not set)`);
    return;
  }
  const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
  const addr = privateKeyToAccount(normalized as `0x${string}`).address;
  const pc = ctx.exchange.client.getViemClient();
  const native = await pc.getBalance({ address: addr });
  const { config } = ctx;
  const collateral = config.addresses.collateral ?? config.addresses.testUsdc;
  let collateralHuman = "—";
  if (collateral) {
    const bal = await ctx.exchange.client.getErc20Balance(collateral, addr);
    collateralHuman = toHuman(bal, config.decimals).toFixed(4);
  }
  console.log(
    `${label.padEnd(12)} ${addr} · gas ${formatUnits(native, 18)} · collateral ${collateralHuman}`,
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = createExchange({ withSigner: false });
  await ctx.exchange.loadMarkets(true);

  console.log(`\nnetwork   : ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`indexer   : ${cfg.indexerUrl}`);
  console.log(`dryRun    : ${cfg.dryRun} (doctor ignores this)`);
  console.log(
    `book grid : decimals=${cfg.decimals} tick=${cfg.tick.toString()} lot=${cfg.lot.toString()} ` +
      `(MM_TICK/MM_LOT overrides)`,
  );
  console.log(`venue env : ${cfg.venueId ?? "(unset — may infer or error on multi-venue)"}`);

  let resolved: Awaited<ReturnType<typeof resolveVenue>>;
  try {
    resolved = await resolveVenue(ctx);
  } catch (e) {
    console.log(`\nvenue     : ERROR — ${(e as Error).message}`);
    await shutdown(ctx);
    process.exit(1);
  }

  console.log(
    `\nvenue     : ${shortVenue(resolved.scope)} · source=${resolved.source} · scoped active=${resolved.markets}`,
  );

  await printWallet("PRIVATE_KEY", process.env.PRIVATE_KEY, ctx);
  await printWallet("TAKER_KEY", process.env.TAKER_PRIVATE_KEY, ctx);

  const markets = await activeMarkets(ctx, { max: 12 });
  console.log(`\nmarkets   : showing up to ${markets.length} scoped row(s)\n`);

  const nowSec = Math.floor(Date.now() / 1000);
  for (const m of markets) {
    const onchain = await marketOnchain(ctx, m);
    if (!onchain) {
      console.log(`${m.symbol.padEnd(28)} (no on-chain snapshot)`);
      continue;
    }
    const left = Number(onchain.expiry) - nowSec;
    const leftS = left > 0 ? `${Math.round(left / 60)}m` : "expired";
    const tradable = isTradable(onchain) ? "Trading" : statusName(onchain.status);
    const { yes } = outcomeSymbols(m);
    let book = "book[—]";
    try {
      const snap = await snapshot(ctx, yes, 3);
      const bid = snap.bestYesBid?.toFixed(3) ?? "—";
      const ask = snap.bestYesAsk?.toFixed(3) ?? "—";
      book = `YES bid=${bid} ask=${ask}`;
    } catch (e) {
      book = `book ERROR: ${(e as Error).message.slice(0, 60)}`;
    }
    console.log(`${m.symbol.padEnd(28)} ${tradable.padEnd(10)} ttl=${leftS.padEnd(8)} ${book}`);
  }

  if (markets.length === 0) {
    console.log(
      "\nhint      : if scoped active=0 but indexer has binaries, set VENUE_ID from a live market row " +
        "(see docs/event-contracts.md).",
    );
  }

  console.log();
  await shutdown(ctx);
}

// Exit explicitly. `shutdown()` races the exchange's close against a 3s timeout,
// so a websocket that outlives it keeps the event loop alive and the doctor
// never returns — with its whole report already printed. Same hang as
// scripts/ec-test/post-check.ts had.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
