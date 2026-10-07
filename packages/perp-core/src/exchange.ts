/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// The single entry point every perp strategy uses. Builds one `SomniaMarkets`
// from .env, and hands back the exchange plus the resolved config.

import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { loadConfig, loadEnv, makeChain, type PerpConfig } from "./config.js";
import type { PerpMarket } from "./markets.js";
import { createTradingKey, linkProblem, linkStatus, type TradingKey } from "./operator.js";

export interface PerpContext {
  exchange: SomniaMarkets;
  config: PerpConfig;
  /** True when a signer (PRIVATE_KEY) is loaded, which writes require. */
  canTrade: boolean;
  /**
   * Set in trading-key mode (OWNER_ADDRESS). The exchange then reads as the
   * owner, so `exchange.walletAddress`, positions and margin are the account's,
   * and order writes go through this key as `…For` calls.
   */
  tradingKey?: TradingKey;
}

/**
 * Build the exchange. Pass `{ withSigner: true }` to require a PRIVATE_KEY.
 *
 * `wsRpcUrl` is not optional even for a read-only bot: chain access itself is
 * websocket-backed, so `loadMarkets()` throws `NotConfiguredError` without it
 * rather than falling back to HTTP.
 *
 * The bundled testnet address set serves Hideki too: the singletons the SDK
 * looks up sit at the same deterministic addresses there, and the perp pool,
 * MarginBank and stop registry come off each market row rather than from it.
 */
export function createExchange(opts: { withSigner?: boolean } = {}): PerpContext {
  loadEnv();
  const config = loadConfig();

  if (opts.withSigner && !config.privateKey) {
    throw new Error(
      "PRIVATE_KEY is required for trading. Set it in .env, or run with DRY_RUN=true to log intended orders instead.",
    );
  }

  const chain = makeChain(config);
  const base = {
    indexerUrl: config.indexerUrl,
    chain,
    wsRpcUrl: config.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  };

  if (config.owner) {
    // Trading-key mode. The SDK gets the owner as a bare address, which makes it
    // read-only for that account: every read the strategies already make
    // (positions, margin, sizing, the close preview) lands on the account, and
    // the SDK cannot send anything. Writes go through the key below instead.
    const exchange = new SomniaMarkets({ ...base, account: config.owner });
    const tradingKey = config.privateKey
      ? createTradingKey({ owner: config.owner, privateKey: config.privateKey, chain, rpcUrl: config.rpcUrl })
      : undefined;
    return { exchange, config, canTrade: Boolean(tradingKey), tradingKey };
  }

  const exchange = new SomniaMarkets({
    ...base,
    // Loaded whenever one is configured, including under DRY_RUN: the margin
    // preflight and every position read are account-scoped, and a dry run that
    // reported on no account would be describing a different bot. Writes are
    // gated on config.dryRun at the call site, not here.
    privateKey: config.privateKey,
  });

  return { exchange, config, canTrade: Boolean(config.privateKey) };
}

/**
 * The trading-key startup check: is this key linked to OWNER_ADDRESS on this
 * market? Asks the pool itself, which is the check every order then has to pass.
 *
 * `ok` is true outside trading-key mode, and when OWNER_ADDRESS is set without a
 * key (a read-only watch of the account). Run it once, next to the margin
 * preflight, so an unlinked key is one sentence at startup rather than an
 * `OnlyApprovedContracts` revert on every order.
 */
export async function tradingKeyCheck(ctx: PerpContext, market: PerpMarket): Promise<{ ok: boolean; message?: string }> {
  const key = ctx.tradingKey;
  if (!key) {
    return ctx.config.owner
      ? { ok: true, message: `watching ${ctx.config.owner} read-only: set PRIVATE_KEY to the bot key linked to it to trade` }
      : { ok: true };
  }
  const problem = linkProblem(key, await linkStatus(key, market.info.poolAddress), market.display);
  return problem
    ? { ok: false, message: problem }
    : { ok: true, message: `trading key ${key.operator} trades for ${key.owner} on ${market.display}` };
}

/**
 * Throw if a write's receipt says the transaction REVERTED.
 *
 * A backstop, not the primary signal. Measured on the perp order path, the SDK
 * REJECTS on a revert with the named error (`PostOnlyWouldCross`,
 * `ImmediateOrCancelNoFill` and the rest), so a caller that only catches will
 * already have seen it. This stays for the writes that resolve with a receipt
 * instead, and costs nothing on the paths that throw.
 */
export function assertTxOk(res: { hash?: string; receipt?: { status?: string } }, label = "transaction"): void {
  if (res?.receipt?.status === "reverted") {
    throw new Error(
      `${label} REVERTED on-chain (tx ${res.hash ?? "?"}). The SDK does not throw on a reverted receipt; ` +
        "check margin, the tick grid and the market's own status before retrying.",
    );
  }
}

/**
 * Close the exchange without letting a one-shot script hang. The live-tail
 * socket can keep the event loop alive past `close()`, so this caps the wait.
 */
export async function shutdown(ctx: PerpContext, timeoutMs = 3_000): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(ctx.exchange.close?.()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // A close that fails is not worth failing a run over.
  }
}

/** Interruptible sleep. Wakes within ~500ms of the stop flag turning true. */
export async function sleep(ms: number, stopped?: () => boolean): Promise<void> {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
}

/** Ctrl-C handling shared by the long-running strategies. */
export function onStop(): () => boolean {
  let stopped = false;
  const stop = () => {
    if (stopped) process.exit(1);
    stopped = true;
    console.log("\nstopping, finishing the current cycle first. Press Ctrl-C again to exit now.");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return () => stopped;
}
