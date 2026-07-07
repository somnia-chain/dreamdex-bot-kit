/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { getActiveNetwork } from "../config/network.js";
import { logger } from "../utils/logger.js";

export interface RestClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface MarketInfo {
  symbol: string;
  baseToken?: string;
  quoteToken?: string;
  [key: string]: unknown;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp?: number;
}

export interface RecentTrade {
  price: string;
  size: string;
  side?: "buy" | "sell";
  timestamp?: number;
  [key: string]: unknown;
}

export class DreamDexRestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private jwt: string | undefined;

  constructor(opts: RestClientOptions = {}) {
    const net = getActiveNetwork();
    this.baseUrl = (opts.baseUrl ?? net.restApi).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  setJwt(jwt: string): void {
    this.jwt = jwt;
  }

  hasAuth(): boolean {
    return this.jwt !== undefined;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.jwt) headers.set("Authorization", `Bearer ${this.jwt}`);

    try {
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      const text = await res.text();
      const body = text ? safeJson<unknown>(text) : undefined;
      if (!res.ok) {
        const err = new Error(`DreamDEX REST ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 200)}`);
        (err as Error & { status?: number; body?: unknown }).status = res.status;
        (err as Error & { status?: number; body?: unknown }).body = body;
        throw err;
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getMarkets(): Promise<MarketInfo[]> {
    const data = await this.request<MarketInfo[] | { data: MarketInfo[] } | { markets: MarketInfo[] }>("/markets");
    return normalizeList<MarketInfo>(data);
  }

  async getOrderBook(symbol: string): Promise<OrderBookSnapshot> {
    const encoded = encodeURIComponent(symbol);
    const data = await this.request<unknown>(`/orderbooks?symbols=${encoded}`);
    const raw = Array.isArray(data) ? data[0] : data;
    const obj = (raw ?? {}) as {
      symbol?: string;
      bids?: OrderBookLevel[];
      asks?: OrderBookLevel[];
      timestamp?: number;
    };
    return {
      symbol: obj.symbol ?? symbol,
      bids: obj.bids ?? [],
      asks: obj.asks ?? [],
      timestamp: obj.timestamp,
    };
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<RecentTrade[]> {
    const encoded = encodeURIComponent(symbol);
    const data = await this.request<RecentTrade[] | { data: RecentTrade[] }>(
      `/markets/${encoded}/trades?limit=${limit}`,
    );
    return normalizeList<RecentTrade>(data);
  }

  async getNonce(address: string): Promise<{ nonce: string; message?: string }> {
    return this.request(`/auth/nonce?address=${address}`);
  }

  async login(siweMessage: string, signature: string): Promise<{ jwt: string }> {
    const res = await this.request<{ jwt?: string; token?: string }>(`/auth/login`, {
      method: "POST",
      body: JSON.stringify({ message: siweMessage, signature }),
    });
    const jwt = res.jwt ?? res.token;
    if (!jwt) throw new Error("Login response missing jwt/token");
    this.jwt = jwt;
    logger.info("Authenticated to DreamDEX REST (SIWE)");
    return { jwt };
  }
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function normalizeList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.markets)) return obj.markets as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}
