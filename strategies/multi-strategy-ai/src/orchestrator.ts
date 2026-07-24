/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import {
  createChainContext,
  Pool,
  DreamDexWs,
  ORDER_TYPE,
  shiftBps,
  ERC20_ABI,
  fromRaw,
  type ChainContext,
  type WsMessage,
} from "@dreamdex-bot-kit/core";
import { config } from "./config.js";
import { getDecision } from "./brain/index.js";
import {
  checkCircuitBreaker,
  createRiskState,
  recordRealizedPnl,
  validateTrade,
  type RiskState,
} from "./risk.js";
import { recordOutcome, recordSnapshot, recordTrade } from "./memory.js";
import { GridStrategy } from "./strategies/grid.js";
import { MeanReversionStrategy } from "./strategies/mean-reversion.js";
import { MomentumStrategy } from "./strategies/momentum.js";
import type { Strategy, StrategyContext, WsEvent } from "./strategies/base.js";
import type { MarketSnapshot, Position, SignalResult } from "./types.js";

function log(msg: string, extra?: unknown): void {
  const line = `[multi-strategy-ai ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function walletQuote(ctx: ChainContext, pool: Pool): Promise<number> {
  const subject = ctx.owner ?? ctx.account.address;
  const raw = await ctx.publicClient.readContract({
    address: pool.params.quoteToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [subject],
  });
  return fromRaw(raw, pool.quoteDecimals);
}

export class Orchestrator {
  private ctx!: ChainContext;
  private pool!: Pool;
  private ws?: DreamDexWs;
  private strategies: Strategy[] = [];
  private mids: number[] = [];
  private position?: Position;
  private risk!: RiskState;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private cycleBusy = false;

  async start(): Promise<void> {
    this.ctx = createChainContext();
    log(
      `network=${this.ctx.net.name} wallet=${this.ctx.account.address} dryRun=${config.dryRun} ai=${config.features.ai}`,
    );

    this.pool = await Pool.load(this.ctx, config.symbol);
    log(`market ${config.symbol} tick=${this.pool.tick} lot=${this.pool.lot} minQty=${this.pool.minQty}`);

    const [base, quote] = await Promise.all([this.pool.walletBase(), walletQuote(this.ctx, this.pool)]);
    const { mid } = await this.pool.topOfBook();
    const startingEquity = quote + base * (mid ?? 0);
    this.risk = createRiskState(startingEquity > 0 ? startingEquity : config.notionalUsdso * 10);
    log(`starting equity ≈ ${this.risk.startingEquity.toFixed(4)} quote-units`);

    const sctx: StrategyContext = {
      log,
      pool: this.pool,
      walletAddress: this.ctx.account.address,
      dryRun: config.dryRun,
      cfg: config,
    };

    if (config.features.momentum) this.strategies.push(new MomentumStrategy(sctx));
    if (config.features.meanReversion) this.strategies.push(new MeanReversionStrategy(sctx));
    if (config.features.grid) this.strategies.push(new GridStrategy(sctx));
    if (this.strategies.length === 0) {
      throw new Error("No strategies enabled — set FEATURES_MOMENTUM / MEAN_REVERSION / GRID");
    }
    log(`modules: ${this.strategies.map((s) => s.name).join(", ")}`);

    for (const s of this.strategies) await s.start();

    this.ws = new DreamDexWs(this.ctx.net, (msg) => {
      void this.onWs(msg);
    });
    this.ws.subscribeOrderbook([config.symbol]);
    this.ws.subscribeTrades([config.symbol]);
    this.ws.connect();

    this.running = true;
    this.timer = setInterval(() => {
      void this.cycle().catch((e) => log("cycle error", (e as Error).message));
    }, config.loopMs);
    await this.cycle();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
    for (const s of this.strategies) await s.stop();
    if (this.position) {
      log("shutdown — flattening open position");
      await this.exitPosition("shutdown flatten");
    }
  }

  private async onWs(msg: WsMessage): Promise<void> {
    const event = msg as WsEvent;
    for (const s of this.strategies) {
      try {
        await s.onWsEvent(event);
      } catch (e) {
        log(`${s.name} onWsEvent error`, (e as Error).message);
      }
    }

    // Opportunistically sample mid from orderbook pushes between cycles.
    if (event.channel === "orderbook") {
      const data = event.data as { bids?: Array<{ price?: string }>; asks?: Array<{ price?: string }> } | undefined;
      const bid = data?.bids?.[0]?.price ? Number(data.bids[0].price) : undefined;
      const ask = data?.asks?.[0]?.price ? Number(data.asks[0].price) : undefined;
      if (bid !== undefined && ask !== undefined && Number.isFinite(bid) && Number.isFinite(ask)) {
        this.pushMid((bid + ask) / 2);
      }
    }
  }

  private pushMid(mid: number): void {
    if (!Number.isFinite(mid) || mid <= 0) return;
    this.mids.push(mid);
    if (this.mids.length > config.windowSize) this.mids.shift();
  }

  private async cycle(): Promise<void> {
    if (!this.running || this.cycleBusy) return;
    this.cycleBusy = true;
    try {
      this.risk = checkCircuitBreaker(this.risk, config);
      if (this.risk.halted) {
        log(`HALTED — ${this.risk.haltReason}`);
        return;
      }

      const book = await this.pool.topOfBook();
      if (book.mid === undefined) {
        log("empty book — skip cycle");
        return;
      }
      this.pushMid(book.mid);

      const [baseInventory, quoteInventory] = await Promise.all([
        this.pool.walletBase(),
        walletQuote(this.ctx, this.pool),
      ]);

      // Manage open long: TP / SL before new entries.
      if (this.position && book.bestBid !== undefined) {
        const pnlPct = (book.mid - this.position.entry) / this.position.entry;
        if (pnlPct >= config.takeProfitPct || book.mid >= this.position.takeProfit) {
          await this.exitPosition(`take-profit ${(pnlPct * 100).toFixed(2)}%`);
          return;
        }
        if (pnlPct <= -config.stopLossPct || book.mid <= this.position.stopLoss) {
          await this.exitPosition(`stop-loss ${(pnlPct * 100).toFixed(2)}%`);
          return;
        }
      }

      const snap: MarketSnapshot = {
        symbol: config.symbol,
        mid: book.mid,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        baseInventory,
        quoteInventory,
        mids: [...this.mids],
      };

      const signals: SignalResult[] = this.strategies.map((s) => s.analyze(snap));
      for (const sig of signals) {
        log(`signal ${sig.strategy}=${sig.signal} conf=${sig.confidence.toFixed(2)} — ${sig.reason}`);
      }

      const decision = await getDecision(signals, snap, config, log);
      log(
        `decision ${decision.action} via ${decision.strategy} (${decision.source}) conf=${decision.confidence.toFixed(2)} — ${decision.reasoning}`,
      );
      recordSnapshot(signals, decision);

      // Open long: exit on SELL signal, otherwise wait for TP/SL.
      if (this.position) {
        if (decision.action === "SELL" && decision.confidence >= 0.3) {
          await this.exitPosition(`ensemble SELL (${decision.strategy})`);
          return;
        }
        log(`holding long qty=${this.position.qty.toFixed(6)} entry=${this.position.entry.toFixed(6)}`);
        return;
      }

      const validation = validateTrade(
        decision,
        { base: baseInventory, quote: quoteInventory },
        this.pool.minQty,
        config,
        this.risk,
      );
      if (!validation.approved || !validation.adjusted) {
        log(`risk rejected: ${validation.reason}`);
        return;
      }
      const trade = validation.adjusted;
      if (trade.action === "HOLD") return;

      await this.execute(
        {
          action: trade.action,
          strategy: trade.strategy,
          price: trade.price,
          amount: trade.amount,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          confidence: trade.confidence,
          reasoning: trade.reasoning,
          source: trade.source,
        },
        book.bestBid,
        book.bestAsk,
      );
    } finally {
      this.cycleBusy = false;
    }
  }

  private async execute(
    trade: { action: "BUY" | "SELL"; strategy: Position["strategy"]; price: number; amount: number; stopLoss: number; takeProfit: number; confidence: number; reasoning: string; source: string },
    bestBid?: number,
    bestAsk?: number,
  ): Promise<void> {
    const isBuy = trade.action === "BUY";
    const touch = isBuy ? (bestAsk ?? trade.price) : (bestBid ?? trade.price);
    const price = isBuy ? shiftBps(touch, config.crossBps) : shiftBps(touch, -config.crossBps);
    const qty = trade.amount;

    if (qty < this.pool.minQty) {
      log(`qty ${qty.toFixed(6)} below minQty ${this.pool.minQty}`);
      return;
    }

    log(
      `${config.dryRun ? "[dry-run] would" : "placing"} ${trade.action} ${qty.toFixed(6)} @ ~${touch.toFixed(6)} (${trade.strategy})`,
    );

    if (config.dryRun) {
      if (isBuy) {
        this.position = {
          entry: touch,
          qty,
          stopLoss: trade.stopLoss || touch * (1 - config.stopLossPct),
          takeProfit: trade.takeProfit || touch * (1 + config.takeProfitPct),
          strategy: trade.strategy,
          openedAt: Date.now(),
        };
      }
      recordTrade({
        at: new Date().toISOString(),
        action: trade.action,
        strategy: trade.strategy,
        price: touch,
        amount: qty,
        confidence: trade.confidence,
        source: trade.source,
        reasoning: trade.reasoning,
        dryRun: true,
      });
      return;
    }

    try {
      const res = await this.pool.place({
        isBid: isBuy,
        price,
        qty,
        orderType: ORDER_TYPE.ImmediateOrCancel,
      });
      log(`placed ${trade.action} tx=${res.txHash} orderId=${res.orderId}`);
      recordTrade({
        at: new Date().toISOString(),
        action: trade.action,
        strategy: trade.strategy,
        price: touch,
        amount: qty,
        confidence: trade.confidence,
        source: trade.source,
        reasoning: trade.reasoning,
        dryRun: false,
        txHash: res.txHash,
      });
      if (isBuy) {
        this.position = {
          entry: touch,
          qty,
          stopLoss: trade.stopLoss || touch * (1 - config.stopLossPct),
          takeProfit: trade.takeProfit || touch * (1 + config.takeProfitPct),
          strategy: trade.strategy,
          openedAt: Date.now(),
        };
      }
    } catch (err) {
      log(`place ${trade.action} failed`, (err as Error).message);
    }
  }

  private async exitPosition(reason: string): Promise<void> {
    const pos = this.position;
    if (!pos) return;
    this.position = undefined;

    const { bestBid, mid } = await this.pool.topOfBook();
    const exitPx = bestBid ?? mid;
    if (exitPx === undefined) {
      log(`cannot exit — empty book (${reason})`);
      this.position = pos; // restore so next cycle retries
      return;
    }

    const pnl = (exitPx - pos.entry) * pos.qty;
    log(`EXIT ${pos.qty.toFixed(6)} @ ~${exitPx.toFixed(6)} pnl≈${pnl.toFixed(4)} — ${reason}`);
    this.risk = recordRealizedPnl(this.risk, pnl);
    recordOutcome(pos.strategy, pnl);

    if (config.dryRun) return;

    try {
      const price = shiftBps(exitPx, -config.crossBps);
      await this.pool.place({
        isBid: false,
        price,
        qty: pos.qty,
        orderType: ORDER_TYPE.ImmediateOrCancel,
      });
    } catch (err) {
      log("exit failed", (err as Error).message);
    }
  }
}
