/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { logger } from "./utils/logger.js";
import { getChainContext } from "./utils/signer.js";
import { getPoolHandle } from "./dex/contracts.js";
import { DreamDexWsClient } from "./dex/websocket.js";
import { MarketMakerStrategy } from "./strategies/market-maker.js";
import { Day7LiquidatorStrategy } from "./strategies/day7-liquidator.js";
import { MomentumStrategy } from "./strategies/momentum.js";
import { Strategy } from "./strategies/base.js";
import {
  ALLOCATIONS,
  PAIRS,
  SPREADS_BPS,
  ORDER,
  FEATURES,
  DAY7,
  MS_PER_HOUR,
} from "./config/constants.js";

export interface OrchestratorOptions {
  dryRun?: boolean;
}

export class Orchestrator {
  private strategies: Strategy[] = [];
  private ws: DreamDexWsClient | undefined;
  private shutdownRequested = false;
  private shutdownDone: (() => void) | undefined;
  private shutdownComplete: Promise<void> | undefined;

  constructor(private readonly opts: OrchestratorOptions = {}) {}

  async start(): Promise<void> {
    const ctx = await getChainContext();
    if (!ctx.wallet && !this.opts.dryRun) {
      logger.warn(
        "No PRIVATE_KEY set — forcing dry-run mode (strategies will not place orders)",
      );
      this.opts.dryRun = true;
    }
    const address = ctx.wallet?.address ?? "0x0000000000000000000000000000000000000000";

    if (FEATURES.primaryMM) {
      try {
        const primary = await this.buildMM(
          PAIRS.primary,
          SPREADS_BPS.primary,
          ORDER.notionalUsdso * ALLOCATIONS.primaryMM,
          address,
        );
        if (primary) this.strategies.push(primary);
      } catch (err) {
        logger.warn(
          { pair: PAIRS.primary, err: (err as Error).message },
          "Primary MM unavailable, skipping",
        );
      }
    }

    if (FEATURES.secondaryMM) {
      try {
        const secondary = await this.buildMM(
          PAIRS.secondary,
          SPREADS_BPS.secondary,
          ORDER.notionalUsdso * ALLOCATIONS.secondaryMM,
          address,
        );
        if (secondary) this.strategies.push(secondary);
      } catch (err) {
        logger.warn(
          { pair: PAIRS.secondary, err: (err as Error).message },
          "Secondary MM unavailable, skipping",
        );
      }
    }

    if (FEATURES.day7Liquidator) {
      try {
        const day7 = await this.buildDay7(PAIRS.primary, address);
        if (day7) this.strategies.push(day7);
      } catch (err) {
        logger.warn(
          { pair: PAIRS.primary, err: (err as Error).message },
          "Day-7 liquidator unavailable on primary pool, skipping",
        );
      }
    }

    if (FEATURES.momentum) {
      try {
        const momentum = await this.buildMomentum(
          PAIRS.secondary,
          ORDER.notionalUsdso * ALLOCATIONS.momentum,
          address,
        );
        if (momentum) this.strategies.push(momentum);
      } catch (err) {
        logger.warn(
          { pair: PAIRS.secondary, err: (err as Error).message },
          "Momentum chaser unavailable, skipping",
        );
      }
    }

    if (this.strategies.length === 0) {
      logger.error("No strategies started — exiting");
      return;
    }

    this.ws = new DreamDexWsClient();
    this.ws.onMessage((msg) => {
      for (const s of this.strategies) {
        s.onWsEvent(msg as Parameters<Strategy["onWsEvent"]>[0]).catch((err) =>
          logger.error({ err, strategy: s.name }, "Strategy WS handler failed"),
        );
      }
    });
    try {
      await this.ws.connect();
      const symbols = this.strategies
        .map((s) => s.name.replace(/^MM:/, ""))
        .filter((sym, idx, arr) => arr.indexOf(sym) === idx);
      for (const sym of symbols) {
        this.ws.subscribe("orderbook", { symbols: [sym] });
        this.ws.subscribe("trades", { symbols: [sym] });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "WS connect failed — continuing without WS");
    }

    for (const s of this.strategies) {
      try {
        await s.start();
      } catch (err) {
        logger.error({ strategy: s.name, err }, "Failed to start strategy");
      }
    }

    logger.info(
      { count: this.strategies.length, dryRun: this.opts.dryRun ?? false },
      "Orchestrator running",
    );

    this.shutdownComplete = new Promise<void>((resolve) => {
      this.shutdownDone = resolve;
    });
    const onSig = (sig: string): void => {
      logger.info({ sig }, "Signal received");
      this.shutdown().catch((err) => logger.error({ err }, "Shutdown failed"));
    };
    process.on("SIGINT", () => onSig("SIGINT"));
    process.on("SIGTERM", () => onSig("SIGTERM"));

    await this.shutdownComplete;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    logger.info("Shutdown requested — stopping strategies");

    for (const s of this.strategies) {
      try {
        await s.stop();
      } catch (err) {
        logger.error({ strategy: s.name, err }, "Strategy stop failed");
      }
    }
    this.ws?.close();
    logger.info("Shutdown complete");
    this.shutdownDone?.();
  }

  private async buildMM(
    symbol: string,
    spreadBps: number,
    allocatedNotional: number,
    walletAddress: string,
  ): Promise<MarketMakerStrategy | undefined> {
    const pool = await getPoolHandle(symbol);
    const seedMid = seedMidForPair(symbol);
    return new MarketMakerStrategy(
      {
        logger,
        pool,
        walletAddress,
        dryRun: this.opts.dryRun ?? false,
      },
      {
        spreadBps,
        notionalUsdso: allocatedNotional,
        seedMid,
        requoteTriggerBps: ORDER.requoteTriggerBps,
        refreshIntervalMs: 15_000,
        expireMs: MS_PER_HOUR,
      },
    );
  }

  private async buildDay7(
    symbol: string,
    walletAddress: string,
  ): Promise<Day7LiquidatorStrategy | undefined> {
    const pool = await getPoolHandle(symbol);
    return new Day7LiquidatorStrategy(
      {
        logger,
        pool,
        walletAddress,
        dryRun: this.opts.dryRun ?? false,
      },
      {
        fireAtIsoUtc: DAY7.liquidateAt,
        checkIntervalMs: 60_000,
        slippageBps: 100,
      },
    );
  }

  private async buildMomentum(
    symbol: string,
    notional: number,
    walletAddress: string,
  ): Promise<MomentumStrategy | undefined> {
    const pool = await getPoolHandle(symbol);
    return new MomentumStrategy(
      {
        logger,
        pool,
        walletAddress,
        dryRun: this.opts.dryRun ?? false,
      },
      {
        windowMs: 60_000,
        thresholdBps: 50,
        notionalUsdso: notional,
        cooldownMs: 30_000,
      },
    );
  }
}

function seedMidForPair(symbol: string): number | undefined {
  if (symbol === "USDC.e:USDso") return 1.0;
  if (symbol === "SOMI:USDso") return 0.17;
  return undefined;
}
