/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { createServer, type ServerResponse } from 'node:http';

export interface TradeRecord {
  at: number;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  filledAmount: string;
  notional: number;
}

export interface EquityPoint {
  at: number;
  value: number;
}

export interface BotSnapshot {
  symbol: string;
  strategy: string;
  executionMode: string;
  startedAt: number;
  baseBalance: number;
  quoteBalance: number;
  totalTrades: number;
  totalVolume: number;
  statusLine: string;
  equitySeries: EquityPoint[];
  recentTrades: TradeRecord[];
}

type SnapshotCore = Omit<BotSnapshot, 'equitySeries' | 'recentTrades'>;

export class MetricsServer {
  private readonly clients = new Set<ServerResponse>();
  private core: SnapshotCore = {
    symbol: '',
    strategy: '',
    executionMode: '',
    startedAt: Date.now(),
    baseBalance: 0,
    quoteBalance: 0,
    totalTrades: 0,
    totalVolume: 0,
    statusLine: 'starting...',
  };
  private readonly equitySeries: EquityPoint[] = [];
  private readonly recentTrades: TradeRecord[] = [];

  constructor(private readonly port: number) {}

  start(): void {
    const server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://x').pathname;

      if (pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.snapshot()));
        return;
      }

      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        this.emit(res, 'state', this.snapshot());
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(this.port, () =>
      console.log(`[metrics] http://localhost:${this.port}`),
    );

    // Heartbeat keeps SSE connections alive and refreshes the dashboard.
    setInterval(() => this.broadcast('heartbeat', this.snapshot()), 5_000);
  }

  update(fields: Partial<SnapshotCore>): void {
    Object.assign(this.core, fields);
  }

  pushTrade(trade: TradeRecord): void {
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > 100) this.recentTrades.pop();
    this.core.totalTrades += 1;
    this.core.totalVolume += trade.notional;
    this.broadcast('trade', this.snapshot());
  }

  pushEquity(value: number): void {
    this.equitySeries.push({ at: Date.now(), value });
    if (this.equitySeries.length > 500) this.equitySeries.shift();
  }

  private snapshot(): BotSnapshot {
    return {
      ...this.core,
      equitySeries: [...this.equitySeries],
      recentTrades: [...this.recentTrades],
    };
  }

  private emit(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    for (const client of this.clients) this.emit(client, event, data);
  }
}
