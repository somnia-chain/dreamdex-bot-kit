/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Order placement that survives an 18-decimal venue.
//
// The unified `exchange.createOrder` converts a human price with
// `parseUnits(price.toFixed(decimals), decimals)`. At 18 decimals that exposes
// the float's binary representation: `(0.05).toFixed(18)` is
// "0.050000000000000003", three wei off the tick grid, and the pool rejects it
// with `InvalidPrice`. Measured on mainnet: of fifteen ordinary probabilities
// only 0.25, 0.5 and 0.75 survive — the ones binary floating point represents
// exactly. A 6-decimal venue never shows this, which is why testnet is clean
// and mainnet is not.
//
// So we never hand a float to the SDK. Prices and sizes are converted in TICK
// and LOT units — small integers, where a single `Math.round` absorbs the
// epsilon — and sent through the raw trader tier as exact bigints. The same
// path the app itself uses.
//
// This module also folds in two things every caller was repeating: a reverted
// write does not throw (check the receipt), and orders must carry an expiry
// capped at the market's own.

import { ORDER_TYPE, type BinarySide, type MarketOnchain, type UnifiedMarket } from "@somnia-chain/markets-sdk";
import { assertTxOk, type EcContext } from "./exchange.js";

/** Which leg of the market an order is on. */
export type Outcome = "YES" | "NO";

export interface PlaceLimitArgs {
  /** The market being traded, and the on-chain snapshot you validated it with. */
  market: UnifiedMarket;
  onchain: MarketOnchain;
  /** The leg you are trading. Prices below are in THIS leg's own probability. */
  outcome: Outcome;
  side: "buy" | "sell";
  /** Probability in (0, 1), in the outcome's own terms. Snapped to the tick grid. */
  price: number;
  /** Shares. Snapped DOWN to the lot grid; 0 after snapping means "too small to send". */
  size: number;
  /**
   * `post-only` rests or is rejected, never takes. `ioc` takes what crosses and
   * cancels the rest. `limit` takes what crosses and rests the remainder.
   */
  type?: "post-only" | "ioc" | "limit";
  /**
   * Dead-man's switch, seconds from now. Always capped at the market's own
   * expiry, because the venue rejects anything later. Default 5 minutes.
   */
  expiresInSec?: number;
}

export interface PlacedOrder {
  /** True when quantity is still resting on the book. */
  rested: boolean;
  /** On-chain order id, present only when something rested. */
  orderId?: bigint;
  /** Shares filled in this transaction, human units. */
  filled: number;
  /** Shares requested after lot snapping, human units. */
  size: number;
  /** The tick-snapped price actually sent, in the outcome's own terms. */
  price: number;
  hash?: string;
}

const SIDES: Record<`${Outcome}-${"buy" | "sell"}`, BinarySide> = {
  "YES-buy": "BUY_YES",
  "YES-sell": "SELL_YES",
  "NO-buy": "BUY_NO",
  "NO-sell": "SELL_NO",
};

/**
 * Snap a human quantity to a whole number of grid steps.
 *
 * `stepsPerOne` is small (1000 on an 18-decimal venue with a 1e15 tick), so the
 * float multiply here cannot drift by a whole step and `Math.round` lands on the
 * intended one. Multiplying by 10^18 instead — which is what the SDK does — is
 * exactly the bug this module exists to avoid.
 */
function toSteps(human: number, one: bigint, step: bigint, mode: "round" | "floor"): bigint {
  const stepsPerOne = Number(one / step);
  const n = human * stepsPerOne;
  const steps = mode === "round" ? Math.round(n) : Math.floor(n + 1e-9);
  return BigInt(Math.max(0, steps)) * step;
}

/**
 * Place a limit order with an exactly-representable price.
 *
 * Returns `size: 0` without sending anything when the request rounds below one
 * lot — the same skip a caller would otherwise have to write itself.
 */
export async function placeLimit(ctx: EcContext, args: PlaceLimitArgs): Promise<PlacedOrder> {
  const { market, onchain, outcome, side, type = "post-only" } = args;
  const one = 10n ** BigInt(ctx.config.decimals);

  // Sizes snap DOWN: never send more than asked for.
  const quantity = toSteps(args.size, one, ctx.config.lot, "floor");
  const priceOwn = toSteps(args.price, one, ctx.config.tick, "round");
  if (quantity <= 0n) {
    return { rested: false, filled: 0, size: 0, price: Number(priceOwn) / Number(one) };
  }
  if (priceOwn <= 0n || priceOwn >= one) {
    throw new Error(`price ${args.price} is outside (0, 1) after snapping to the tick grid`);
  }

  // The book is quoted in YES terms whichever leg you are on: a NO order's price
  // is the complement. Integer subtraction, so it stays on the grid.
  const priceYes = outcome === "YES" ? priceOwn : one - priceOwn;

  // Orders must expire no later than the market itself.
  const nowSec = Math.floor(Date.now() / 1000);
  const wanted = nowSec + (args.expiresInSec ?? 300);
  const expiresAt = Math.min(wanted, Number(onchain.expiry));
  if (expiresAt <= nowSec) {
    return { rested: false, filled: 0, size: 0, price: Number(priceOwn) / Number(one) };
  }

  await assertFunded(ctx, onchain, outcome, side, priceOwn, quantity);

  const res = await ctx.exchange.trader.placeOrder({
    pool: onchain.pool,
    side: SIDES[`${outcome}-${side}`],
    price: priceYes,
    quantity,
    outcomeToken: onchain.outcomeToken,
    yesId: onchain.yesId,
    noId: onchain.noId,
    orderType:
      type === "post-only" ? ORDER_TYPE.POST_ONLY : type === "ioc" ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT,
    expireTimestampNs: BigInt(expiresAt) * 1_000_000_000n,
  });

  // A post-only that would have crossed REVERTS with `PostOnlyWouldCross()`, so
  // the call above throws and this line is never reached in that case. On a
  // quoting loop that is a routine event, not a fault: the touch moved through
  // your price between the read and the send. Catch it around `placeLimit` and
  // requote, and let anything else propagate.
  assertTxOk(res, `${SIDES[`${outcome}-${side}`]} ${market.symbol}`);

  const filledRaw = (res.fills ?? []).reduce((acc, f) => acc + f.quantityFilled, 0n);
  const rested = res.orderId !== undefined && filledRaw < quantity;
  if (rested) restingOrders.set(String(res.orderId), onchain);
  return {
    rested,
    orderId: res.orderId,
    filled: Number(filledRaw) / Number(one),
    size: Number(quantity) / Number(one),
    price: Number(priceOwn) / Number(one),
    hash: res.hash,
  };
}

/**
 * How much of `want` you can actually sell, snapped to the lot grid.
 *
 * You can only sell an outcome you hold, and the kit seeds a fixed inventory
 * (`MM_INVENTORY`, 1 share on mainnet) that has nothing to do with a strategy's
 * trade size. Left alone those two disagree: a bot sizing orders at 5 tries to
 * sell 5 against a seeded 1, and every sell fails. Ask for the sellable size
 * instead of assuming, and skip the leg when it comes back 0.
 */
export async function sellableSize(
  ctx: EcContext,
  onchain: MarketOnchain,
  outcome: Outcome,
  want: number,
): Promise<number> {
  const me = ctx.exchange.walletAddress;
  if (!me) return 0;
  const id = outcome === "YES" ? onchain.yesId : onchain.noId;
  const held = await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: me, id: id });
  const one = 10n ** BigInt(ctx.config.decimals);
  const heldHuman = Number(held) / Number(one);
  const capped = toSteps(Math.min(want, heldHuman), one, ctx.config.lot, "floor");
  return Number(capped) / Number(one);
}

/**
 * Refuse an order the wallet cannot back, before it costs gas.
 *
 * A reverted write does not throw (see `assertTxOk`), so an underfunded bot
 * does not stop: it keeps sending orders that revert, burning gas on every
 * cycle. Measured on mainnet, that is exactly how it fails, and the on-chain
 * reason is opaque unless you decode the selector: `ERC20InsufficientBalance`
 * for a buy with no collateral, `InsufficientBalance()` for a sell with no
 * outcome tokens.
 *
 * A buy escrows `price x quantity` of collateral, in the leg's OWN price, taken
 * straight from the wallet. A sell escrows the outcome tokens themselves, and
 * there is no naked short. The per-pool vault is a payout FALLBACK rather than a
 * spending balance (cancel refunds land back in the wallet), but count it when
 * it is non-zero, since placement draws it first.
 */
async function assertFunded(
  ctx: EcContext,
  onchain: MarketOnchain,
  outcome: Outcome,
  side: "buy" | "sell",
  priceOwn: bigint,
  quantity: bigint,
): Promise<void> {
  const { client } = ctx.exchange;
  const me = ctx.exchange.walletAddress;
  if (!me) return; // no signer: the write itself will say so

  // Gas first, because an empty gas tank does not look like an empty gas tank.
  // The node rejects with "insufficient balance", viem wraps it as "Missing or
  // invalid parameters", and the bot logs that once per market per cycle
  // forever. Measured: 24 identical lines before anyone thought to look at the
  // native balance.
  const gas = await client.getViemClient().getBalance({ address: me });
  if (gas === 0n) {
    throw new Error(`out of gas: ${me} holds 0 native token on ${ctx.config.network}. Fund it to trade.`);
  }

  if (side === "sell") {
    const id = outcome === "YES" ? onchain.yesId : onchain.noId;
    const held = await client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: me, id: id });
    if (held < quantity) {
      throw new Error(
        `not enough ${outcome} to sell: hold ${held}, need ${quantity} (raw). ` +
          `Selling needs inventory — mint a complete set first, there is no naked short.`,
      );
    }
    return;
  }

  const need = (priceOwn * quantity) / 10n ** BigInt(ctx.config.decimals);
  const [wallet, vault] = await Promise.all([
    client.getErc20Balance(onchain.collateral, me),
    client.getVaultBalance({ vault: onchain.pool, owner: me, token: onchain.collateral }).catch(() => 0n),
  ]);
  if (wallet + vault < need) {
    throw new Error(
      `not enough collateral: have ${wallet + vault}, need ${need} (raw) for ${outcome} buy. ` +
        `Fund ${onchain.collateral} → ${me}.`,
    );
  }
}

/**
 * Orders this process placed that rested, with the snapshot needed to cancel
 * them.
 *
 * Kept here rather than asked for at shutdown. The indexer runs seconds behind,
 * so the orders it cannot see yet are exactly the ones still resting. Measured
 * on testnet: ec-starter stranded 3 orders while logging "canceled 0", and
 * ec-maker stranded 1 while logging "canceled 14" — both had asked the indexer.
 */
const restingOrders = new Map<string, MarketOnchain>();

/**
 * Forget an order we pulled by another route — the unified `cancelOrder`, say,
 * which a requoting loop uses every cycle. Without this the record only grows,
 * and the shutdown line reads "cancelled 13 of 34" when 21 of those were pulled
 * long ago.
 */
export function untrackOrder(orderId: bigint | string): void {
  restingOrders.delete(String(orderId));
}

/**
 * Reverts that mean the order is already off the book. A filled or cancelled
 * id no longer names a live order of ours: the pool answers
 * `IncorrectSender(caller, 0x0)` for an empty slot, `IncorrectSender(caller,
 * other)` when another trader's newer order reuses the slot, and
 * `IncorrectOrder()` when our own newer order does. Every other failure (the
 * post-expiry `CloseNotCaptured()` lock, `InsufficientGasForPayout`, a network
 * error, a mined revert) leaves the order resting.
 */
const GONE_REVERTS = new Set(["IncorrectSender", "IncorrectOrder"]);

/** True when a cancel failed only because the order was already filled or pulled. */
export function isOrderGone(err: unknown): boolean {
  const name = (err as { errorName?: unknown } | null)?.errorName;
  return typeof name === "string" && GONE_REVERTS.has(name);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

/**
 * Cancel one order through the unified API without letting a failure stop the
 * caller's loop. "cancelled": pulled now. "gone": it had already filled or been
 * pulled. "failed": it may still be resting, and the reason is logged.
 */
export async function tryCancel(
  ctx: EcContext,
  orderId: string,
  symbol: string,
): Promise<"cancelled" | "gone" | "failed"> {
  try {
    await ctx.exchange.cancelOrder(orderId, symbol);
  } catch (err) {
    if (!isOrderGone(err)) {
      log(`cancel ${orderId} on ${symbol} failed, the order may still be resting: ${errText(err)}`);
      return "failed";
    }
    untrackOrder(orderId);
    return "gone";
  }
  untrackOrder(orderId);
  return "cancelled";
}

/**
 * Cancel every order this process placed and has not already pulled. Call it on
 * the way out. An order that filled or was pulled in the meantime is simply
 * gone. Any other failure is logged and counted in `failed`, and the order stays
 * tracked, because it may still be resting.
 */
export async function cancelTracked(
  ctx: EcContext,
): Promise<{ cancelled: number; tracked: number; failed: number }> {
  const tracked = restingOrders.size;
  let cancelled = 0;
  let failed = 0;
  for (const [id, onchain] of [...restingOrders]) {
    try {
      await cancelById(ctx, onchain, id);
      cancelled++;
    } catch (err) {
      if (!isOrderGone(err)) {
        failed++;
        log(`cancel ${id} failed, the order may still be resting: ${errText(err)}`);
        continue;
      }
    }
    restingOrders.delete(id);
  }
  return { cancelled, tracked, failed };
}

/**
 * Net position on a market, in human units: YES held minus NO held.
 *
 * A complete set (one of each) is worth exactly one collateral whatever the
 * outcome, so the risk a bot carries is the IMBALANCE, not the gross holding.
 */
export async function netPosition(ctx: EcContext, onchain: MarketOnchain): Promise<number> {
  const me = ctx.exchange.walletAddress;
  if (!me) return 0;
  const one = Number(10n ** BigInt(ctx.config.decimals));
  const [yes, no] = await Promise.all([
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: me, id: onchain.yesId }),
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: me, id: onchain.noId }),
  ]);
  return (Number(yes) - Number(no)) / one;
}

/**
 * Cancel our resting orders on THIS venue's live markets.
 *
 * `exchange.fetchOpenOrders()` with no symbol reaches across the binary, spot
 * and perp portfolios — the whole wallet. Using it to tidy up on the way out
 * means a bot sharing a key with anything else pulls that other thing's orders
 * too. Ask per market instead, over the venue scope the bot actually trades.
 */
export async function cancelVenueOrders(ctx: EcContext): Promise<number> {
  const { activeMarkets, outcomeSymbols } = await import("./markets.js");
  let cancelled = 0;
  for (const m of await activeMarkets(ctx, { max: 100 })) {
    const { yes } = outcomeSymbols(m);
    for (const o of await ctx.exchange.fetchOpenOrders(yes).catch(() => [])) {
      if ((await tryCancel(ctx, o.id, yes)) === "cancelled") cancelled++;
    }
  }
  return cancelled;
}

/** Cancel one resting order by its on-chain id. */
export async function cancelById(ctx: EcContext, onchain: MarketOnchain, orderId: bigint | string) {
  const res = await ctx.exchange.trader.cancelOrder({ pool: onchain.pool, orderId });
  assertTxOk(res, `cancel ${orderId}`);
  return res;
}

/**
 * How much headroom a bot should demand before trading a window, scaled to the
 * series rather than fixed.
 *
 * A flat threshold cannot serve both cadences: 300s is right for the 15m and 1h
 * series but swallows a 5-minute window whole, and a venue running those exists
 * today, where a fixed stop means the bot never trades at all rather than
 * trading carefully.
 */
export function minLeftSec(intervalSec: number | null | undefined, capSec = 300): number {
  const override = Number(process.env.EC_MIN_LEFT_S);
  if (Number.isFinite(override) && override > 0) return override;
  return headroomSec(intervalSec, capSec);
}

export function headroomSec(intervalSec: number | null | undefined, capSec = 300): number {
  if (!intervalSec || intervalSec <= 0) return capSec;
  return Math.max(30, Math.min(capSec, intervalSec * 0.4));
}
