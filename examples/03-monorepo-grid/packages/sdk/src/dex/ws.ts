/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import WebSocket from 'ws';
import type { WebSocketOrderBookMessage } from './types.js';

export class DreamDexWsClient {
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private intentionallyClosed = false;
  private reconnectDelay = 1_000;

  constructor(private readonly url: string) {}

  connect(onOrderBook: (message: WebSocketOrderBookMessage) => Promise<void> | void): Promise<void> {
    this.intentionallyClosed = false;
    return this.openConnection(onOrderBook);
  }

  private openConnection(
    onOrderBook: (message: WebSocketOrderBookMessage) => Promise<void> | void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.once('open', () => {
        this.reconnectDelay = 1_000;
        this.startHeartbeat();
        resolve();
      });

      ws.on('message', async (raw) => {
        const text = raw.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.error('WebSocket: failed to parse message');
          return;
        }

        const message = parsed as WebSocketOrderBookMessage | { operation?: string };

        if ('operation' in message && message.operation === 'pong') {
          return;
        }

        if ('channel' in message && (message as WebSocketOrderBookMessage).channel === 'orderbook') {
          try {
            await onOrderBook(message as WebSocketOrderBookMessage);
          } catch (error) {
            console.error('WebSocket orderbook handler failed:', error);
          }
        }
      });

      ws.once('error', (error) => {
        // Fires before 'open' on connection failure; after 'open', 'close' will follow.
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(error);
        } else {
          console.error('WebSocket error:', error);
        }
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        if (this.intentionallyClosed) {
          return;
        }
        console.warn(`DreamDEX WebSocket disconnected; reconnecting in ${this.reconnectDelay}ms`);
        setTimeout(() => {
          if (!this.intentionallyClosed) {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
            this.openConnection(onOrderBook).catch((error) => {
              console.error('WebSocket reconnect failed:', error);
            });
          }
        }, this.reconnectDelay);
      });
    });
  }

  subscribeOrderBook(symbol: string): void {
    this.send({
      operation: 'subscribe',
      channel: 'orderbook',
      params: { symbols: [symbol] },
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try {
        this.send({ operation: 'ping' });
      } catch (error) {
        console.error('WebSocket heartbeat failed:', error);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
