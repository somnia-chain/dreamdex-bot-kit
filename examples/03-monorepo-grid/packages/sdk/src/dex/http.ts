/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Wallet } from 'ethers';
import { signSiweMessage } from './auth.js';
import type {
  AuthLoginResponse,
  AuthNonceResponse,
  MarketInfo,
  Order,
  OrderBook,
  PrepareOrderRequest,
  UnsignedTransactionPayload,
} from './types.js';

export class DreamDexHttpClient {
  private token?: string;
  private tokenExpiresAt?: number;
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  constructor(
    private readonly baseUrl: string,
    private readonly wallet: Wallet,
    private readonly chainId: number,
    private readonly siweDomain: string,
    private readonly siweUri: string,
  ) {}

  async listMarkets(): Promise<MarketInfo[]> {
    const response = await this.request<{ markets: MarketInfo[] }>('/v0/markets', {
      retries: 2,
    });
    return response.markets;
  }

  async getOrderBook(symbol: string, depth = 5): Promise<OrderBook | undefined> {
    const query = new URLSearchParams({ symbols: symbol, depth: String(depth) });
    const response = await this.request<{ orderbooks: OrderBook[] }>(
      `/v0/orderbooks?${query.toString()}`,
      { retries: 3 },
    );
    return response.orderbooks.find((book) => book.symbol === symbol);
  }

  async prepareOrder(symbol: string, body: PrepareOrderRequest): Promise<UnsignedTransactionPayload> {
    await this.ensureAuthenticated();
    return this.request<UnsignedTransactionPayload>(`/v0/markets/${encodeURIComponent(symbol)}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth: true,
      retries: 1,
    });
  }

  async fetchOrder(symbol: string, orderId: string): Promise<Order> {
    await this.ensureAuthenticated();
    return this.request<Order>(`/v0/markets/${encodeURIComponent(symbol)}/orders/${encodeURIComponent(orderId)}`, {
      auth: true,
      retries: 2,
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt && now < this.tokenExpiresAt - 60_000) {
      return;
    }

    const nonceResponse = await this.request<AuthNonceResponse>('/v0/auth/nonce', {
      retries: 2,
    });
    const signed = await signSiweMessage(
      this.wallet,
      nonceResponse.nonce,
      this.chainId,
      this.siweDomain,
      this.siweUri,
    );
    const { message, signature } = JSON.parse(signed) as { message: string; signature: string };
    const login = await this.request<AuthLoginResponse>('/v0/auth/login', {
      method: 'POST',
      body: JSON.stringify({ message, signature }),
      retries: 1,
    });

    this.token = login.token;
    this.tokenExpiresAt = login.expiresAt;
  }

  private async request<T>(
    path: string,
    options?: {
      method?: string;
      body?: string;
      auth?: boolean;
      retries?: number;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (options?.auth) {
      if (!this.token) {
        throw new Error('Auth token is missing');
      }
      headers.Authorization = `Bearer ${this.token}`;
    }

    const method = options?.method ?? 'GET';
    const retries = options?.retries ?? (method === 'GET' ? 2 : 0);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: options?.body,
          signal: AbortSignal.timeout(DreamDexHttpClient.REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`DreamDEX HTTP ${response.status}: ${text}`);

          if (!isRetryableStatus(response.status) || attempt === retries) {
            throw error;
          }

          console.warn(
            `[http] ${method} ${path} failed with ${response.status}; retrying (${attempt + 1}/${retries})`,
          );
          await sleep(getBackoffDelayMs(attempt));
          continue;
        }

        return (await response.json()) as T;
      } catch (error) {
        if (!isRetryableRequestError(error) || attempt === retries) {
          throw error;
        }

        console.warn(
          `[http] ${method} ${path} request failed (${formatError(error)}); retrying (${attempt + 1}/${retries})`,
        );
        await sleep(getBackoffDelayMs(attempt));
      }
    }

    throw new Error(`Unexpected request exhaustion for ${method} ${path}`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'TimeoutError') {
    return true;
  }

  const cause = (error as Error & { cause?: { code?: string } }).cause;
  return (
    error.message.includes('fetch failed') ||
    cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    cause?.code === 'ECONNRESET' ||
    cause?.code === 'ETIMEDOUT'
  );
}

function getBackoffDelayMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
