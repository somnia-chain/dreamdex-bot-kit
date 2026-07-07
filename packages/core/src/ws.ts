/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// WebSocket market-data feed with heartbeat + auto-reconnect.
//
// The server closes idle connections after 60s, so we ping every 30s. On any
// disconnect we reconnect with backoff and REPLAY the subscriptions — a bot that
// silently stops receiving book updates is worse than one that crashes, because
// it keeps quoting on a frozen view. Pair this with an occasional REST/on-chain
// reconcile of the book (see docs/24-7-operations.md on staleness).

import WebSocket from "ws";
import type { NetworkConfig } from "./config/networks.js";

export type WsMessage = Record<string, unknown> & { channel?: string; type?: string };

interface Subscription {
  channel: string;
  params: Record<string, unknown>;
}

export class DreamDexWs {
  private ws: WebSocket | null = null;
  private subs: Subscription[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1_000;
  private closed = false;

  constructor(
    private readonly net: NetworkConfig,
    private readonly onMessage: (msg: WsMessage) => void,
    private readonly onReconnect?: () => void,
  ) {}

  connect(): void {
    this.closed = false;
    const ws = new WebSocket(this.net.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1_000;
      for (const s of this.subs) this.send({ operation: "subscribe", channel: s.channel, params: s.params });
      this.heartbeat = setInterval(() => this.send({ operation: "ping" }), 30_000);
      this.onReconnect?.();
    });

    ws.on("message", (data) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.operation === "pong") return;
      this.onMessage(msg);
    });

    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => ws.close());
  }

  subscribe(channel: string, params: Record<string, unknown>): void {
    this.subs.push({ channel, params });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ operation: "subscribe", channel, params });
    }
  }

  subscribeOrderbook(symbols: string[]): void {
    this.subscribe("orderbook", { symbols });
  }

  subscribeTrades(symbols: string[]): void {
    this.subscribe("trades", { symbols });
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private scheduleReconnect(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30_000); // exponential backoff, capped
    setTimeout(() => this.connect(), delay);
  }
}
