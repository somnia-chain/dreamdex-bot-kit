/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// DreamDEX REST client with built-in SIWE auth.
//
// Auth flow (EIP-4361 "Sign-In with Ethereum"): GET a nonce, sign a SIWE
// message, POST it to /auth/login for a JWT. The JWT is cached and refreshed a
// few minutes before it expires so a long-running bot never trades on a stale
// token. The `Chain ID` in the SIWE message MUST match the network you are
// signing txs for (5031 / 50312).
//
// The order/cancel/vault endpoints return an UNSIGNED transaction — you sign and
// broadcast it yourself (see execute.ts). Public market-data endpoints need no auth.

import type { Account } from "viem";
import type { NetworkConfig } from "./config/networks.js";

export interface PreparedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  gasLimit?: string;
  chainId?: string | number;
}

export interface MarketInfo {
  symbol: string;
  contract: `0x${string}`;
  base: `0x${string}`;
  quote: `0x${string}`;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
}

export interface PrepareOrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  amount: string;
  price?: string;
  fundingSource?: "wallet" | "vault";
  orderType?: "normalOrder" | "fillOrKill" | "immediateOrCancel" | "postOnly";
}

const REFRESH_MARGIN_MS = 3 * 60_000; // refresh 3 min before expiry

export class DreamDexRest {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private readonly net: NetworkConfig,
    private readonly account: Account,
  ) {}

  // ── Public market data ──────────────────────────────────────────────────
  async fetchMarkets(): Promise<MarketInfo[]> {
    const body = await this.request<{ markets: MarketInfo[] }>("GET", "/markets", { auth: false });
    return body.markets;
  }

  /** Canonical multi-symbol orderbook endpoint. Prefer this over per-market paths. */
  async fetchOrderbooks(symbols: string[], depth = 5): Promise<unknown> {
    const q = encodeURIComponent(symbols.join(","));
    return this.request("GET", `/orderbooks?symbols=${q}&depth=${depth}`, { auth: false });
  }

  // ── Authenticated: prepare unsigned txs ─────────────────────────────────
  async prepareOrder(input: PrepareOrderInput): Promise<PreparedTx> {
    const { symbol, ...rest } = input;
    return this.request<PreparedTx>("POST", `/markets/${encodeURIComponent(symbol)}/orders`, {
      body: { walletAddress: this.account.address, ...rest },
    });
  }

  async prepareCancel(symbol: string, orderId: string): Promise<PreparedTx> {
    return this.request<PreparedTx>("DELETE", `/markets/${encodeURIComponent(symbol)}/orders/${orderId}`);
  }

  async prepareVaultApprove(symbol: string, currency: string, amount: string): Promise<PreparedTx> {
    return this.request<PreparedTx>("POST", `/markets/${encodeURIComponent(symbol)}/vault/approve`, {
      body: { walletAddress: this.account.address, currency, amount },
    });
  }

  async getOrder(symbol: string, orderId: string): Promise<unknown> {
    return this.request("GET", `/markets/${encodeURIComponent(symbol)}/orders/${orderId}`);
  }

  // ── SIWE auth ────────────────────────────────────────────────────────────
  async ensureAuth(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - REFRESH_MARGIN_MS) return this.token;

    const { nonce } = await this.request<{ nonce: string }>("GET", "/auth/nonce", { auth: false });
    const domain = new URL(this.net.restApi).host;
    const uri = new URL(this.net.restApi).origin;
    const issuedAt = new Date().toISOString();
    const message =
      `${domain} wants you to sign in with your Ethereum account:\n` +
      `${this.account.address}\n\n` +
      `Sign in to dreamDEX\n\n` +
      `URI: ${uri}\n` +
      `Version: 1\n` +
      `Chain ID: ${this.net.chainId}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${issuedAt}`;

    if (!this.account.signMessage) throw new Error("Account cannot sign messages (need a local account).");
    const signature = await this.account.signMessage({ message });

    const login = await this.request<{ token: string; expiresAt: number }>("POST", "/auth/login", {
      auth: false,
      body: { message, signature },
    });
    this.token = login.token;
    this.tokenExpiry = login.expiresAt;
    return this.token;
  }

  // ── Low-level request ────────────────────────────────────────────────────
  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers["Authorization"] = `Bearer ${await this.ensureAuth()}`;

    const res = await fetch(`${this.net.restApi}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : {};
    if (!res.ok) {
      // The stable machine-readable error is in `name`; `description` is for debugging only.
      const name = (parsed as { name?: string }).name ?? res.headers.get("Error-Name") ?? "http_error";
      throw new DreamDexApiError(res.status, name, JSON.stringify(parsed));
    }
    return parsed as T;
  }
}

export class DreamDexApiError extends Error {
  /** The stable, machine-readable error name from the API (e.g. "invalid_amount"). */
  public readonly apiName: string;
  constructor(
    public readonly status: number,
    apiName: string,
    detail: string,
  ) {
    super(`DreamDEX API ${status} ${apiName}: ${detail}`);
    this.name = "DreamDexApiError";
    this.apiName = apiName;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
