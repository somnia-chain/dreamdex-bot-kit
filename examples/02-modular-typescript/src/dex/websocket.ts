/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import WebSocket from "ws";
import { getActiveNetwork } from "../config/network.js";
import { logger } from "../utils/logger.js";

export type WsChannel = "orderbook" | "ohlcv" | "trades" | "order";

export interface SubscribeRequest {
  channel: WsChannel;
  params: Record<string, unknown>;
}

export type WsMessageHandler = (msg: unknown) => void;

export interface WsClientOptions {
  url?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  maxReconnectAttempts?: number;
}

export class DreamDexWsClient {
  private readonly url: string;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly maxReconnectAttempts: number;

  private ws: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private subscriptions: SubscribeRequest[] = [];
  private handlers = new Set<WsMessageHandler>();
  private closedByUser = false;

  constructor(opts: WsClientOptions = {}) {
    const net = getActiveNetwork();
    this.url = opts.url ?? net.wsUrl;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.reconnectMs = opts.reconnectMs ?? 3_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
  }

  onMessage(handler: WsMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closedByUser = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        logger.info({ url: this.url }, "WS connected");
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        for (const sub of this.subscriptions) {
          this.sendRaw({ operation: "subscribe", channel: sub.channel, params: sub.params });
        }
        ws.off("error", onErrorBeforeOpen);
        resolve();
      };

      const onErrorBeforeOpen = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };

      ws.once("open", onOpen);
      ws.once("error", onErrorBeforeOpen);

      ws.on("message", (data) => {
        const text = data.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        for (const h of this.handlers) {
          try {
            h(parsed);
          } catch (err) {
            logger.error({ err }, "WS handler threw");
          }
        }
      });

      ws.on("close", (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, "WS closed");
        this.stopHeartbeat();
        if (!this.closedByUser) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        logger.error({ err: err.message }, "WS error");
      });
    });
  }

  subscribe(channel: WsChannel, params: Record<string, unknown>): void {
    const sub: SubscribeRequest = { channel, params };
    this.subscriptions.push(sub);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw({ operation: "subscribe", channel, params });
    }
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  private sendRaw(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.sendRaw({ operation: "ping" });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(
        { attempts: this.reconnectAttempts },
        "WS reconnect attempts exhausted — giving up",
      );
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.reconnectMs * Math.min(this.reconnectAttempts, 5);
    logger.info({ attempt: this.reconnectAttempts, delay }, "WS reconnecting");
    setTimeout(() => {
      this.connect().catch((err) => logger.error({ err: err.message }, "WS reconnect failed"));
    }, delay);
  }
}
