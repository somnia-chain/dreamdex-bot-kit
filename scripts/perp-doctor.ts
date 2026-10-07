/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Read-only perp preflight: network, wallet + gas, the live perp markets with
// their mark / funding / top-of-book / grid, and — when a PRIVATE_KEY is set —
// the MarginBank account (health, free vs locked collateral), open positions
// and any armed stops. Sends no transactions.
//
// This is the perp counterpart to scripts/doctor.ts (spot) and
// scripts/ec-doctor.ts (event contracts). Run it before a bot to confirm the
// account is funded and the market is priceable, because a perp order locks
// from the MarginBank, not the wallet, and an empty bank fails every order.
//
// With OWNER_ADDRESS set (trading-key mode) the account is the owner's, the gas
// is the bot key's, and it also reports whether the key is linked to the owner.
//
//   NETWORK=hideki npx tsx scripts/perp-doctor.ts
//
import { formatUnits, parseAbi } from "viem";
import {
  createExchange,
  loadConfig,
  shutdown,
  perpMarkets,
  requireMarket,
  marginSnapshot,
  healthRatio,
  liveMark,
  markOf,
  fundingApr,
  pendingStops,
  tradingKeyCheck,
} from "@dreamdex-bot-kit/perp-core";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main(): Promise<void> {
  const cfg = loadConfig();
  // withSigner:false keeps this read-only; the account is still loaded from
  // PRIVATE_KEY when present, so the margin/position reads below have a subject.
  const ctx = createExchange({ withSigner: false });
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;

  console.log(`\nnetwork  : ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`indexer  : ${cfg.indexerUrl}`);
  console.log(`wallet   : ${me ?? "(no PRIVATE_KEY — market view only)"}${cfg.owner ? " (trading-key mode: the account)" : ""}`);
  if (ctx.tradingKey) console.log(`bot key  : ${ctx.tradingKey.operator}`);

  const markets = await perpMarkets(ctx.exchange, true);
  if (markets.length === 0) {
    console.log("\nmarkets  : none live (perps run on testnets only; check NETWORK=hideki or NETWORK=testnet)");
    await shutdown(ctx);
    return;
  }

  const collateral = markets[0].info.quoteToken;
  const quoteDp = markets[0].info.quoteDecimals;
  if (me) {
    const pc = ctx.exchange.client.getViemClient();
    // The key that sends pays the gas: the bot key in trading-key mode.
    const gas = await pc.getBalance({ address: ctx.tradingKey?.operator ?? me });
    if (cfg.owner) {
      const link = await tradingKeyCheck(ctx, markets[0]);
      console.log(`link     : ${link.ok ? "ok" : "NOT LINKED"}${link.message ? ` · ${link.message}` : ""}`);
    }
    const bal = await pc.readContract({ address: collateral, abi: ERC20, functionName: "balanceOf", args: [me] });
    console.log(`gas      : ${formatUnits(gas, 18)} ${cfg.chainId === 5031 ? "SOMI" : "STT"}`);
    console.log(`wallet USDso : ${Number(formatUnits(bal, quoteDp)).toFixed(4)} (in-wallet, not margin)`);

    // Margin is cross-account: one MarginBank backs every market, so read it once.
    const snap = await marginSnapshot(ctx.exchange, markets[0], me);
    const h = (v: bigint) => (Number(v) / 10 ** quoteDp).toFixed(2);
    const ratio = healthRatio(snap);
    console.log(
      `margin   : unlocked ${h(snap.unlocked)} · locked ${h(snap.locked)} · equity ${h(snap.equity)} · ` +
        `withdrawable ${h(snap.withdrawable)} · status ${snap.status} · ` +
        `health ${Number.isFinite(ratio) ? ratio.toFixed(2) + "x" : "∞ (no position)"}`,
    );
    if (snap.equity === 0n && snap.unlocked === 0n) {
      console.log("           ^ empty bank: approve the MarginBank and deposit collateral before trading.");
    }

    const positions = await ctx.exchange.fetchPositions();
    if (positions.length === 0) console.log("positions: none");
    for (const p of positions) {
      console.log(`positions: ${p.symbol} ${p.side} ${p.contracts} · uPnL ${p.unrealizedPnl?.toFixed(4) ?? "?"}`);
    }
  }

  console.log(`\nmarkets  : ${markets.length} live\n`);
  // Funding reads identically on most markets because the rate sits pinned at
  // the positive interest floor; a market that has moved off it stands out.
  for (const m of markets) {
    try {
      const live = await liveMark(ctx.exchange, m);
      const funding = fundingApr(m.info);
      const book = await ctx.exchange.fetchOrderBook(m.symbol, 1);
      const bid = book.bids[0]?.[0];
      const ask = book.asks[0]?.[0];
      const markStr = live !== undefined ? live.toFixed(2) : `un-priceable (row ${markOf(m.info).toFixed(2)})`;
      const stops = me ? (await pendingStops(ctx.exchange, m, me)).length : 0;
      console.log(
        `${m.display.padEnd(10)} mark=${markStr} · funding ${(funding.apr * 100).toFixed(3)}% (pays ${funding.paidSide}s) · ` +
          `book[bid=${bid?.toFixed(1) ?? "—"} ask=${ask?.toFixed(1) ?? "—"}] · ` +
          // Raw units here are unreadable on a 24-decimal market, and reading
          // them wrong is the mistake this script exists to prevent: prices are
          // always 18dp, sizes use the market's own baseDecimals.
          `tick=${formatUnits(BigInt(m.info.tickSize), 18)} lot=${formatUnits(BigInt(m.info.lotSize), m.info.baseDecimals)} ` +
          `minQty=${formatUnits(BigInt(m.info.minQuantity), m.info.baseDecimals)} IM=${m.info.initialMarginBps}bps` +
          (stops ? ` · ${stops} stop(s) armed` : ""),
      );
    } catch (err) {
      console.log(`${m.display.padEnd(10)} ERROR: ${(err as Error).message.slice(0, 90)}`);
    }
  }

  console.log();
  await shutdown(ctx);
}

// Exit explicitly: shutdown() races the exchange close against a timeout, so a
// websocket that outlives it keeps the event loop alive and the doctor never
// returns even though the report is already printed.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
