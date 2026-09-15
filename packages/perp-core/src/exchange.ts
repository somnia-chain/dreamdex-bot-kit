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

export interface PerpContext {
  exchange: SomniaMarkets;
  config: PerpConfig;
  /** True when a signer (PRIVATE_KEY) is loaded, which writes require. */
  canTrade: boolean;
}

/**
 * Build the exchange. Pass `{ withSigner: true }` to require a PRIVATE_KEY.
 *
 * `wsRpcUrl` is not optional even for a read-only bot: chain access itself is
 * websocket-backed, so `loadMarkets()` throws `NotConfiguredError` without it
 * rather than falling back to HTTP.
 */
export function createExchange(opts: { withSigner?: boolean } = {}): PerpContext {
  loadEnv();
  const config = loadConfig();

  if (opts.withSigner && !config.privateKey) {
    throw new Error(
      "PRIVATE_KEY is required for trading. Set it in .env, or run with DRY_RUN=true to log intended orders instead.",
    );
  }

  const exchange = new SomniaMarkets({
    indexerUrl: config.indexerUrl,
    chain: makeChain(config),
    wsRpcUrl: config.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
    // Loaded whenever one is configured, including under DRY_RUN: the margin
    // preflight and every position read are account-scoped, and a dry run that
    // reported on no account would be describing a different bot. Writes are
    // gated on config.dryRun at the call site, not here.
    privateKey: config.privateKey,
  });

  return { exchange, config, canTrade: Boolean(config.privateKey) };
}

/**
 * Throw if a write's receipt says the transaction REVERTED.
 *
 * The SDK signs with fixed fees and skips simulation, and the write helpers
 * resolve with `{ hash, receipt }` WITHOUT checking `receipt.status`, so a
 * reverted order "succeeds" silently unless you check.
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
