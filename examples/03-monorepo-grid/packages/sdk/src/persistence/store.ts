/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StrategyExecution, StrategyPersistentState } from '../dex/types.js';

export interface PersistedBotSnapshot {
  version: 1;
  savedAt: string;
  symbol: string;
  strategy: string;
  executionMode: string;
  metrics: {
    totalExecutions: number;
    totalFilledBase: number;
    totalTradedQuote: number;
    lastExecutionAt?: string;
    lastExecutionSide?: StrategyExecution['side'];
    lastExecutionPrice?: string;
    lastExecutionFilledAmount?: string;
  };
  strategyState?: StrategyPersistentState;
}

interface ExecutionJournalEntry {
  recordedAt: string;
  symbol: string;
  strategy: string;
  executionMode: string;
  execution: StrategyExecution;
  txHash: string;
  approvalTxHash?: string;
  simulatedOrderId?: string;
}

export interface PersistenceContext {
  symbol: string;
  strategy: string;
  executionMode: string;
}

export class BotStateStore {
  private readonly statePath: string;
  private readonly journalPath: string;
  private snapshot: PersistedBotSnapshot;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly baseDir: string,
    private readonly context: PersistenceContext,
    snapshot?: PersistedBotSnapshot,
  ) {
    const fileStem = sanitizeFileStem(`${context.symbol}-${context.strategy}`);
    this.statePath = path.join(baseDir, `${fileStem}.state.json`);
    this.journalPath = path.join(baseDir, `${fileStem}.executions.jsonl`);
    this.snapshot = snapshot ?? createEmptySnapshot(context);
  }

  static async open(
    baseDir: string,
    context: PersistenceContext,
  ): Promise<BotStateStore> {
    await mkdir(baseDir, { recursive: true });
    const store = new BotStateStore(baseDir, context);
    store.snapshot = await store.loadSnapshot();
    return store;
  }

  getSnapshot(): PersistedBotSnapshot {
    return this.snapshot;
  }

  getStatePath(): string {
    return this.statePath;
  }

  getJournalPath(): string {
    return this.journalPath;
  }

  async saveStrategyState(
    strategyState: StrategyPersistentState | undefined,
  ): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      savedAt: new Date().toISOString(),
      strategyState,
    };
    await this.enqueueWrite(async () => {
      await this.writeSnapshot();
    });
  }

  async recordExecution(
    execution: StrategyExecution,
    meta: {
      txHash: string;
      approvalTxHash?: string;
      simulatedOrderId?: string;
      strategyState?: StrategyPersistentState;
    },
  ): Promise<void> {
    const filledAmount = Number(execution.filledAmount);
    const executionPrice = Number(execution.executionPrice);
    const tradedQuote =
      Number.isFinite(filledAmount) && Number.isFinite(executionPrice)
        ? filledAmount * executionPrice
        : 0;

    this.snapshot = {
      ...this.snapshot,
      savedAt: new Date().toISOString(),
      strategyState: meta.strategyState,
      metrics: {
        totalExecutions: this.snapshot.metrics.totalExecutions + 1,
        totalFilledBase:
          this.snapshot.metrics.totalFilledBase +
          (Number.isFinite(filledAmount) ? filledAmount : 0),
        totalTradedQuote: this.snapshot.metrics.totalTradedQuote + tradedQuote,
        lastExecutionAt: new Date().toISOString(),
        lastExecutionSide: execution.side,
        lastExecutionPrice: execution.executionPrice,
        lastExecutionFilledAmount: execution.filledAmount,
      },
    };

    const entry: ExecutionJournalEntry = {
      recordedAt: new Date().toISOString(),
      symbol: this.context.symbol,
      strategy: this.context.strategy,
      executionMode: this.context.executionMode,
      execution,
      txHash: meta.txHash,
      approvalTxHash: meta.approvalTxHash,
      simulatedOrderId: meta.simulatedOrderId,
    };

    await this.enqueueWrite(async () => {
      await this.writeSnapshot();
      await writeFile(this.journalPath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      });
    });
  }

  private async loadSnapshot(): Promise<PersistedBotSnapshot> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedBotSnapshot;
      return {
        ...createEmptySnapshot(this.context),
        ...parsed,
        metrics: {
          ...createEmptySnapshot(this.context).metrics,
          ...parsed.metrics,
        },
      };
    } catch {
      return createEmptySnapshot(this.context);
    }
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.snapshot, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.statePath);
  }

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const nextWrite = this.writeChain.then(task);
    this.writeChain = nextWrite.catch((error) => {
      console.error('[store] State write failed:', error);
    });
    return nextWrite;
  }
}

function createEmptySnapshot(context: PersistenceContext): PersistedBotSnapshot {
  return {
    version: 1,
    savedAt: new Date(0).toISOString(),
    symbol: context.symbol,
    strategy: context.strategy,
    executionMode: context.executionMode,
    metrics: {
      totalExecutions: 0,
      totalFilledBase: 0,
      totalTradedQuote: 0,
    },
  };
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
