/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// perp-starter: the smallest complete perp bot. It opens ONE leveraged
// position and manages it with a take-profit and a stop-loss, then watches
// until one of them fires.
//
//   • margin is checked once at startup, not discovered one revert at a time
//   • the size comes from the pool's own rule, never from a local calculation
//   • the take-profit and stop-loss are armed as a LINKED pair, so whichever
//     fires cancels the other and refunds its SOMI
//   • with a trading key (OWNER_ADDRESS set) the stop registry is not
//     available, because only the account itself can arm a stop. The bot then
//     watches the mark and closes at either level itself, which protects the
//     position only while the bot is running.
//
// DRY_RUN=true (the default) logs intended orders without sending them. Set
// DRY_RUN=false with a funded PRIVATE_KEY to trade for real.
//
//   npm run dev -w perp-starter

import {
  ORDER_TYPE,
  armBracket,
  cancelStops,
  closePosition,
  createExchange,
  ensureLeverage,
  envNum,
  loadEnv,
  liveMark,
  markOf,
  onStop,
  pendingStops,
  placePerp,
  positionIn,
  preflight,
  requireMarket,
  shutdown,
  sizeForNotional,
  sizeOrder,
  sleep,
  somiPerStop,
  tradingKeyCheck,
  type Side,
} from "@dreamdex-bot-kit/perp-core";

// Read .env BEFORE the constants below are evaluated. ES modules evaluate
// top-level bindings at import time, which is earlier than any call inside
// main(), so a config read here would otherwise always see the defaults.
loadEnv();
const SIDE = ((process.env.PERP_SIDE ?? "long").trim().toLowerCase() === "short" ? "short" : "long") as Side;
const LEVERAGE = envNum("PERP_LEVERAGE", 2);
const NOTIONAL = envNum("PERP_NOTIONAL_USDSO", 50);
const TAKE_PROFIT_PCT = envNum("PERP_TAKE_PROFIT_PCT", 2);
const STOP_LOSS_PCT = envNum("PERP_STOP_LOSS_PCT", 1);
const TICK_MS = envNum("PERP_TICK_MS", 10_000);

async function main(): Promise<void> {
  const ctx = createExchange({ withSigner: process.env.DRY_RUN === "false" });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, ctx.config.symbol || "BTC-PERP");
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;
  // A trading key cannot arm stops for the account, so it guards the exit itself.
  const watchedExits = Boolean(ctx.config.owner);

  console.log(
    `perp-starter on ${market.display} (${market.symbol}) | ${SIDE} ${NOTIONAL} USDso at ${LEVERAGE}x | ` +
      `take-profit ${TAKE_PROFIT_PCT}% stop-loss ${STOP_LOSS_PCT}% | dry-run ${ctx.config.dryRun}`,
  );

  if (!me) {
    console.log("read-only: no PRIVATE_KEY, so nothing will be sent. Set one to trade.");
  } else {
    const link = await tradingKeyCheck(ctx, market);
    if (link.message) console.log(link.message);
    if (!link.ok && !ctx.config.dryRun) process.exit(1);

    // PERP_NOTIONAL_USDSO is position value, not margin posted: at 2x a
    // notional of 50 needs about 25 in the bank.
    const check = await preflight(ctx.exchange, market, me, { requiredUsdso: NOTIONAL / Math.max(1, LEVERAGE) });
    console.log(check.message);
    if (!check.ok) process.exit(1);

    if (watchedExits) {
      console.log(
        "trading key: the take-profit and stop-loss are watched by this bot, not armed on the stop registry, " +
          "so they only act while the bot runs.",
      );
    } else {
      const somi = await somiPerStop(ctx.exchange, market);
      console.log(`each pending stop locks ${Number(somi) / 1e18} SOMI, refunded on cancel; a bracket needs two.`);
    }
  }

  // The lever is per market and per account, and it is a floor on margin rather
  // than a display preference: choosing 10x on a market whose initial margin is
  // 5% means holding 10% instead. Set it before sizing, so the preview the pool
  // returns is the one this bot will trade against.
  if (me) {
    const lev = await ensureLeverage(ctx, market, me, LEVERAGE);
    // A dry run has already said what it would set.
    if (!lev.dryRun) console.log(
      lev.changed
        ? `leverage set to ${lev.to}x on ${market.display} (was ${lev.from || "unset"})`
        : lev.ownerOnly
          ? `leverage on ${market.display} is ${lev.from ? `${lev.from}x` : "unset"} for this account; a trading key cannot change it. ` +
            `Set ${LEVERAGE}x in the app if you want it, sizing follows the account's setting.`
          : `leverage already ${lev.to}x on ${market.display}, left alone`,
    );
  }

  const existing = me ? await positionIn(ctx.exchange, market) : undefined;
  if (existing) {
    console.log(`already ${existing.side} ${existing.contracts} ${market.info.baseSymbol}, managing it instead of opening another`);
  } else {
    const book = await ctx.exchange.fetchOrderBook(market.symbol, 1);
    const touch = SIDE === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
    if (touch === undefined) {
      console.log("no counterparty resting on the book, nothing to cross");
      await shutdown(ctx);
      return;
    }
    const price = BigInt(Math.round(touch * 1e18));
    const wanted = sizeForNotional(NOTIONAL, market.info, await liveMark(ctx.exchange, market));
    const sized = me
      ? await sizeOrder(ctx.exchange, { market, account: me, side: SIDE, price, wanted, autoPull: true, tradingKey: ctx.tradingKey })
      : { ok: true as const, quantity: wanted, limitedBy: undefined };

    if (!sized.ok) {
      console.log(`cannot open: ${sized.reason}`);
      await shutdown(ctx);
      return;
    }
    if (sized.limitedBy) {
      console.log(`size ceiling is set by ${sized.limitedBy} (this is not an error on its own)`);
    }
    const opened = await placePerp({
      ctx,
      market,
      side: SIDE,
      price,
      quantity: sized.quantity,
      orderType: ORDER_TYPE.MARKET,
      label: "open",
    });
    if (opened.sent && opened.filled === 0n) {
      console.log("nothing crossed, the price moved. Exiting rather than resting an unintended maker order.");
      await shutdown(ctx);
      return;
    }
  }

  // An armed bracket is already doing this job. Arming a second one would lock
  // another 0.30 SOMI and leave two pairs racing to close the same position.
  // A trading key arms nothing, but it still says what the account has armed.
  const armedAlready = me ? await pendingStops(ctx.exchange, market, me) : [];
  if (armedAlready.length > 0) {
    console.log(`${armedAlready.length} stop(s) already armed on ${market.display}, leaving them alone`);
  }

  // Set the levels against the mark the POOL acts on, not the market row's.
  // The row lags by tens of minutes, so triggers derived from it sit at prices
  // the pool never had.
  const mark = (await liveMark(ctx.exchange, market)) ?? markOf(market.info);
  const up = BigInt(Math.round(mark * (1 + TAKE_PROFIT_PCT / 100) * 1e18));
  const down = BigInt(Math.round(mark * (1 - STOP_LOSS_PCT / 100) * 1e18));
  const takeProfit = SIDE === "long" ? up : down;
  const stopLoss = SIDE === "long" ? down : up;
  const px = (v: bigint) => (Number(v) / 1e18).toFixed(2);

  let bracket: { sent: boolean };
  if (watchedExits) {
    console.log(`${ctx.config.dryRun ? "[dry-run] would watch" : "watching"} take-profit ${px(takeProfit)} and stop-loss ${px(stopLoss)}`);
    bracket = { sent: false };
  } else if (armedAlready.length > 0) {
    bracket = { sent: false };
  } else {
    bracket = await armBracket({ ctx, market, position: SIDE, takeProfit, stopLoss });
  }

  if (ctx.config.dryRun || !me) {
    await shutdown(ctx);
    return;
  }

  // Watch until a leg fires or the operator stops the bot.
  let exited = false;
  while (!stopped()) {
    await sleep(TICK_MS, stopped);
    // Re-read the market each cycle. `market.info` is a snapshot taken when the
    // registry was loaded, so a loop that reuses it reports the mark it started
    // with forever, which is exactly the number a watcher is watching.
    const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
    const position = await positionIn(ctx.exchange, fresh);
    const stops = watchedExits ? [] : await pendingStops(ctx.exchange, fresh, me);
    if (!position) {
      if (watchedExits) {
        console.log("position is closed");
      } else {
        console.log("position is closed; cancelling anything the bracket left armed");
        await cancelStops(ctx, fresh, stops.map((s) => s.orderIdRaw));
      }
      break;
    }
    const live = await liveMark(ctx.exchange, fresh);
    console.log(
      `${position.side} ${position.contracts} ${fresh.info.baseSymbol} | uPnL ${position.unrealizedPnl?.toFixed(4) ?? "?"} | ` +
        `${watchedExits ? "exits watched" : `${stops.length} stop(s) armed`} | mark ${live?.toFixed(2) ?? "un-priceable"}`,
    );

    // The watched bracket: close the whole position the first cycle the live
    // mark reaches either level. An un-priceable mark acts on nothing.
    if (watchedExits && live !== undefined) {
      const liveRaw = BigInt(Math.round(live * 1e18));
      const hitTakeProfit = SIDE === "long" ? liveRaw >= takeProfit : liveRaw <= takeProfit;
      const hitStopLoss = SIDE === "long" ? liveRaw <= stopLoss : liveRaw >= stopLoss;
      if (hitTakeProfit || hitStopLoss) {
        await closePosition(ctx, fresh, me, { label: hitTakeProfit ? "take-profit" : "stop-loss" });
        exited = true;
      }
    }
  }

  if (stopped()) {
    if (!watchedExits) {
      // Leaving a stop armed after the bot exits would keep SOMI locked and fire
      // against a position nobody is watching.
      const stops = await pendingStops(ctx.exchange, market, me);
      await cancelStops(ctx, market, stops.map((s) => s.orderIdRaw));
    }
    if (process.env.PERP_FLATTEN_ON_EXIT === "true") {
      await closePosition(ctx, market, me, { label: "flatten on exit" });
    } else if (watchedExits) {
      console.log("the bot is stopping: its take-profit and stop-loss stop with it, the position stays open.");
    }
  }

  console.log(bracket.sent || exited || watchedExits ? "done" : "done (nothing was armed)");
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
