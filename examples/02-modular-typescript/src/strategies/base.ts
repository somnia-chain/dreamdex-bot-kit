/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Logger } from "../utils/logger.js";
import type { PoolHandle } from "../dex/contracts.js";

export type StrategyStatus = "stopped" | "starting" | "running" | "stopping" | "errored";

export interface StrategyMetrics {
  ordersPlaced: number;
  ordersCancelled: number;
  ordersFilled: number;
  volumeUsdso: number;
  errors: number;
  lastTickAt?: number;
}

export interface StrategyContext {
  logger: Logger;
  pool: PoolHandle;
  walletAddress: string;
  dryRun: boolean;
}

export interface WsEvent {
  channel?: string;
  type?: string;
  data?: unknown;
  [key: string]: unknown;
}

export abstract class Strategy {
  readonly name: string;
  status: StrategyStatus = "stopped";
  metrics: StrategyMetrics = {
    ordersPlaced: 0,
    ordersCancelled: 0,
    ordersFilled: 0,
    volumeUsdso: 0,
    errors: 0,
  };

  constructor(name: string, protected readonly ctx: StrategyContext) {
    this.name = name;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  async onWsEvent(_event: WsEvent): Promise<void> {
    // default: noop, override per strategy
  }

  async onTick(): Promise<void> {
    this.metrics.lastTickAt = Date.now();
  }

  protected setStatus(next: StrategyStatus): void {
    this.ctx.logger.info({ strategy: this.name, status: next }, "Strategy status");
    this.status = next;
  }

  protected recordError(err: unknown): void {
    this.metrics.errors += 1;
    this.ctx.logger.error({ strategy: this.name, err }, "Strategy error");
  }
}
