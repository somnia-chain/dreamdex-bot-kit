/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Margin: the preflight every perp strategy runs before its first order, and
// the health read the guard loops on.
//
// Margin is a prerequisite, not a step. Orders lock collateral from the
// MarginBank, so a bot on an account with an empty bank fails EVERY order, one
// revert at a time, while looking like a market or a pricing problem. The
// preflight below turns that into one sentence at startup.

import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { PerpMarket } from "./markets.js";

export interface MarginSnapshot {
  /** Collateral that is not backing anything, raw quote units. */
  unlocked: bigint;
  locked: bigint;
  /** Collateral plus unrealised PnL. */
  equity: bigint;
  /** What can be withdrawn right now. */
  withdrawable: bigint;
  /** Initial, maintenance and close-out requirements. */
  imReq: bigint;
  mmReq: bigint;
  cmReq: bigint;
  /** The bank's own label for the account's state. */
  status: string;
  /** Pools this account currently has exposure in. */
  activePools: readonly `0x${string}`[];
}

/** Read the account's cross-margin state. Positions are per account, not per market. */
export async function marginSnapshot(
  exchange: SomniaMarkets,
  market: PerpMarket,
  account: `0x${string}`,
): Promise<MarginSnapshot> {
  const a = await exchange.client.getMarginAccount(market.info.marginBank, account);
  return {
    unlocked: a.unlockedCollateralBalance,
    locked: a.lockedCollateral,
    equity: a.equity,
    withdrawable: a.withdrawable,
    imReq: a.imReq,
    mmReq: a.mmReq,
    cmReq: a.cmReq,
    status: String(a.marginStatus),
    activePools: a.activePerpPools as readonly `0x${string}`[],
  };
}

/**
 * Health as a ratio of equity to the maintenance requirement.
 *
 * `Infinity` when nothing is open, which is the honest answer: an account with
 * no position cannot be liquidated, and returning 0 or 1 there would make the
 * guard act on a number that means nothing. Callers compare against their own
 * threshold, so the sentinel never has to be special-cased by them.
 */
export function healthRatio(m: MarginSnapshot): number {
  if (m.mmReq === 0n) return Number.POSITIVE_INFINITY;
  return Number(m.equity) / Number(m.mmReq);
}

export interface PreflightResult {
  ok: boolean;
  /** One line, ready to print. */
  message: string;
  snapshot: MarginSnapshot;
}

/**
 * The startup check. Call it once, before the first order.
 *
 * Reports an empty or unfunded bank as its own failure rather than letting it
 * arrive as a stream of reverts. Deliberately does NOT look at the wallet: a
 * perp order locks from the bank, and auto-pull only fires when the sender owns
 * the order, so wallet balance is not a substitute for a deposit here.
 */
export async function preflight(
  exchange: SomniaMarkets,
  market: PerpMarket,
  account: `0x${string}`,
  opts: { requiredUsdso?: number } = {},
): Promise<PreflightResult> {
  const snapshot = await marginSnapshot(exchange, market, account);
  const decimals = market.info.quoteDecimals;
  const human = (v: bigint) => (Number(v) / 10 ** decimals).toFixed(2);
  const required = opts.requiredUsdso ?? 0;
  const requiredRaw = BigInt(Math.max(0, Math.round(required * 10 ** decimals)));

  if (snapshot.equity === 0n && snapshot.unlocked === 0n) {
    return {
      ok: false,
      snapshot,
      message:
        `MarginBank is empty for ${account}. Deposit collateral before trading: every perp order locks ` +
        `from the bank, not from your wallet, so an unfunded account fails every order. ` +
        `Approve the MarginBank (${market.info.marginBank}) as spender on the collateral token, then deposit.`,
    };
  }

  if (requiredRaw > 0n && snapshot.unlocked < requiredRaw) {
    return {
      ok: false,
      snapshot,
      message:
        `MarginBank has ${human(snapshot.unlocked)} unlocked, and this configuration needs about ` +
        `${required.toFixed(2)} to open its first position. Deposit more, or lower the notional.`,
    };
  }

  return {
    ok: true,
    snapshot,
    message:
      `MarginBank ready: ${human(snapshot.unlocked)} unlocked, ${human(snapshot.locked)} locked, ` +
      `equity ${human(snapshot.equity)}, status ${snapshot.status}.`,
  };
}

/**
 * The collateral an order of this notional will need, at the market's own
 * initial-margin rate.
 *
 * An estimate for the preflight only. The pool adds an adverse mark-to-entry
 * term that a leverage calculation does not, which is why the actual size still
 * comes from `getMaxPerpOrderSize`.
 */
export function marginForNotional(notionalUsdso: number, market: PerpMarket): number {
  const imf = Number(market.info.initialMarginBps) / 10_000;
  return imf > 0 ? notionalUsdso * imf : notionalUsdso;
}

/**
 * Set the account's own leverage cap on one market, if it is not already there.
 *
 * `setMaxLeverage` REVERTS with `NoStateChange()` when the value it is handed is
 * the one already stored, so a bot that sets its lever on every start crashes on
 * its second run. Reading first turns that into a no-op.
 *
 * The cap is a floor on margin rather than a display preference: choosing 10x on
 * a market whose initial margin is 5% means holding 10% instead, and the extra
 * is held against the WHOLE account rather than against this order.
 *
 * Only the account itself can set it. A trading key reads it and leaves it, and
 * `ownerOnly` says so, so the strategy can tell the person to set it in the app.
 */
export async function ensureLeverage(
  ctx: { exchange: SomniaMarkets; config: { dryRun: boolean }; tradingKey?: unknown },
  market: PerpMarket,
  account: `0x${string}`,
  leverageX: number,
): Promise<{ changed: boolean; from: number; to: number; ownerOnly?: boolean }> {
  const current = await ctx.exchange.client.getPerpMaxLeverage({
    marginBank: market.info.marginBank,
    account,
    pool: market.info.poolAddress,
  });
  // 0 means "never set", which carries no extra requirement at all.
  if (current === leverageX) return { changed: false, from: current, to: leverageX };
  if (ctx.tradingKey) return { changed: false, from: current, to: current, ownerOnly: true };
  if (ctx.config.dryRun) {
    console.log(`[dry-run] would set leverage on ${market.display} from ${current || "unset"} to ${leverageX}x`);
    return { changed: false, from: current, to: leverageX };
  }
  await ctx.exchange.trader.setPerpLeverage({ pool: market.info.poolAddress, leverageX });
  return { changed: true, from: current, to: leverageX };
}
