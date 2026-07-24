/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Pool } from "@dreamdex-bot-kit/core";
import type { Config } from "../config.js";
import type { MarketSnapshot, SignalResult, StrategyTag } from "../types.js";

export type StrategyStatus = "stopped" | "starting" | "running" | "stopping" | "errored";

export interface StrategyContext {
  log: (msg: string, extra?: unknown) => void;
  pool: Pool;
  walletAddress: string;
  dryRun: boolean;
  cfg: Config;
}

export interface WsEvent {
  channel?: string;
  type?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** Modular analyzer: observes the market and returns a classical signal. */
export abstract class Strategy {
  status: StrategyStatus = "stopped";

  constructor(
    readonly name: StrategyTag,
    protected readonly ctx: StrategyContext,
  ) {}

  async start(): Promise<void> {
    this.status = "running";
  }

  async stop(): Promise<void> {
    this.status = "stopped";
  }

  async onWsEvent(_event: WsEvent): Promise<void> {
    // default: noop
  }

  /** Produce a BUY / SELL / HOLD advisory from the latest snapshot. */
  abstract analyze(snap: MarketSnapshot): SignalResult;

  protected hold(reason: string, extras?: SignalResult["extras"]): SignalResult {
    return { strategy: this.name, signal: "HOLD", confidence: 0, reason, extras };
  }
}
