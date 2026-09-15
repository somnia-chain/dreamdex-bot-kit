/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Stop orders, and the take-profit / stop-loss bracket built out of a linked
// pair. Three things here are protocol behaviour rather than style:
//
//   • The registry is PER MARKET, on the market row as `stopRegistry`.
//   • Arming a stop needs the OperatorPermissionsRegistry passed explicitly,
//     because the SDK's bundled address sets do not carry that key.
//   • Every pending stop locks SOMI (0.15 on the live markets, a pair twice
//     that). It funds the trigger's gas and comes back on cancel, so an account
//     holding only collateral cannot arm one.

import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { alignPrice, type PerpMarket } from "./markets.js";
import type { Side } from "./orders.js";

/** 0 fires when the mark is at or ABOVE the trigger, 1 when at or below. */
export const TRIGGER_GTE = 0 as const;
export const TRIGGER_LTE = 1 as const;
/** 0 places a limit order at `limitPrice`, 1 a slippage-bounded market order. */
export const STOP_MARKET = 1 as const;

export interface BracketArgs {
  ctx: { exchange: SomniaMarkets; config: { dryRun: boolean; operatorRegistry: `0x${string}` } };
  market: PerpMarket;
  /** The side of the POSITION being protected, not of the closing order. */
  position: Side;
  takeProfit: bigint;
  stopLoss: bigint;
  /** Skip the one-time operator approval once it is known to be in place. */
  skipOperatorApproval?: boolean;
}

export interface BracketResult {
  sent: boolean;
  takeProfitId?: bigint;
  stopLossId?: bigint;
}

/**
 * Arm a take-profit and a stop-loss as ONE linked pair, so whichever fires
 * cancels the other and refunds its SOMI.
 *
 * Both legs carry `quantity: 0`, which is a sentinel rather than an empty
 * order: it means "whatever the position is when this fires", so the bracket
 * keeps covering a position that grew after it was armed. A fixed quantity is
 * only ever clamped down.
 *
 * The registry enforces the pair's shape: same owner, same side, OPPOSITE
 * trigger operators, straddling, and both reduce-only. Closing a long means
 * selling, so both legs are `isBid: false` on a long.
 */
export async function armBracket(args: BracketArgs): Promise<BracketResult> {
  const { ctx, market, position } = args;
  const closingIsBid = position === "short";
  const tp = alignPrice(args.takeProfit, market.info);
  const sl = alignPrice(args.stopLoss, market.info);

  // A long takes profit ABOVE the mark and stops out below; a short is the
  // mirror. Getting this backwards is rejected by the registry rather than
  // silently armed, but the error says "not straddling", which is harder to
  // read than the check.
  const tpOperator = position === "long" ? TRIGGER_GTE : TRIGGER_LTE;
  const slOperator = position === "long" ? TRIGGER_LTE : TRIGGER_GTE;
  const upper = tp > sl ? tp : sl;
  const lower = tp > sl ? sl : tp;
  if (upper === lower) {
    throw new Error("take-profit and stop-loss resolve to the same trigger price after tick alignment");
  }

  const px = (v: bigint) => (Number(v) / 1e18).toFixed(2);
  if (ctx.config.dryRun) {
    console.log(
      `[dry-run] would arm a ${position} bracket on ${market.display}: ` +
        `take-profit ${px(tp)}, stop-loss ${px(sl)}, whole position, 0.30 SOMI locked`,
    );
    return { sent: false };
  }

  const res = await ctx.exchange.trader.placePerpStopOrder({
    registry: market.info.stopRegistry,
    pool: market.info.poolAddress,
    operatorRegistry: ctx.config.operatorRegistry,
    isBid: closingIsBid,
    quantity: 0n,
    triggerPrice: tp,
    triggerOperator: tpOperator,
    stopOrderType: STOP_MARKET,
    intent: "reduceOnly",
    skipOperatorApproval: args.skipOperatorApproval,
    pair: {
      isBid: closingIsBid,
      quantity: 0n,
      triggerPrice: sl,
      triggerOperator: slOperator,
      stopOrderType: STOP_MARKET,
    },
  });

  console.log(
    `armed a ${position} bracket on ${market.display}: take-profit ${px(tp)} (#${res.stopOrderId}), ` +
      `stop-loss ${px(sl)} (#${res.pairedStopOrderId})`,
  );
  return { sent: true, takeProfitId: res.stopOrderId, stopLossId: res.pairedStopOrderId };
}

/**
 * Tear a bracket down in one transaction.
 *
 * Cancelling ONE leg cancels one leg: the other stays armed and simply becomes
 * unlinked, which is rarely what a bot that is flattening wants. The batch is
 * all-or-nothing, so a stale id reverts it rather than silently skipping.
 */
export async function cancelStops(
  ctx: { exchange: SomniaMarkets; config: { dryRun: boolean } },
  market: PerpMarket,
  orderIds: readonly (bigint | string)[],
): Promise<void> {
  const live = orderIds.filter((id) => id !== undefined && id !== null);
  if (live.length === 0) return;
  if (ctx.config.dryRun) {
    console.log(`[dry-run] would cancel ${live.length} stop order(s) and reclaim their SOMI`);
    return;
  }
  await ctx.exchange.trader.cancelPerpStopOrders({ registry: market.info.stopRegistry, orderIds: [...live] });
  console.log(`cancelled ${live.length} stop order(s), SOMI refunded`);
}

/** This account's pending stops in one market. */
export async function pendingStops(exchange: SomniaMarkets, market: PerpMarket, account: `0x${string}`) {
  return exchange.client.listPerpStopOrders({ account, pool: market.info.poolAddress });
}

/**
 * The SOMI one pending stop locks, raw wei.
 *
 * Read rather than hardcoded: it is registry configuration, and a bot that
 * assumes the current 0.15 will arm nothing on a registry that raises it.
 */
export async function somiPerStop(exchange: SomniaMarkets, market: PerpMarket): Promise<bigint> {
  return exchange.client.getPerpStopOrderSomiPayment(market.info.stopRegistry);
}

/**
 * Whether a triggered stop that placed nothing is a fault.
 *
 * `ReduceOnly*` are ordinary outcomes of a stop that events overtook: the
 * position was already closed, or flipped, or what remained was dust. Only
 * `PlacementFailed` and `NoFill` are rejections. Collapsing them all into
 * "failed" makes routine behaviour look broken.
 */
export function isRealStopFailure(dropReason: string | null | undefined): boolean {
  return dropReason === "PlacementFailed" || dropReason === "NoFill";
}
