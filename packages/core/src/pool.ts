/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// A Pool handle — the ergonomic API a strategy actually uses. Wraps a market's
// on-chain params and gives you human-unit reads (top of book) and writes
// (place / cancel) that quantize to tick/lot and route through the safe
// execute.ts path. Strategies should not touch raw units or ABIs directly.

import type { ChainContext } from "./client.js";
import { MARKETS, NATIVE_SENTINEL } from "./config/tokens.js";
import {
  SPOT_POOL_ABI,
  ERC20_ABI,
  readPoolParams,
  readBookLevels,
  readWithdrawableBalance,
  type PoolParams,
} from "./contract.js";
import { placeOrder, cancelOrder, placeOrderFor, cancelOrderFor, type ExecCtx, type PlaceOrderResult } from "./execute.js";
import { ORDER_TYPE, buildExpireNs } from "./gotchas.js";
import { toRaw, fromRaw, alignToTick, alignToLot } from "./quant.js";

export interface TopOfBook {
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
}

export interface PlaceArgs {
  isBid: boolean;
  price: number; // human units
  qty: number; // human base units
  orderType?: number; // default IOC
  expireMs?: number; // default 1h
}

export class Pool {
  private constructor(
    private readonly ctx: ChainContext,
    readonly symbol: string,
    readonly address: `0x${string}`,
    readonly baseIsNative: boolean,
    readonly params: PoolParams,
    readonly baseDecimals: number,
    readonly quoteDecimals: number,
  ) {}

  static async load(ctx: ChainContext, symbol: string): Promise<Pool> {
    const meta = MARKETS[ctx.net.name][symbol];
    if (!meta) throw new Error(`Unknown market "${symbol}" on ${ctx.net.name}. See packages/core/src/config/tokens.ts.`);
    const params = await readPoolParams(ctx.publicClient, meta.pool);
    return new Pool(ctx, symbol, meta.pool, meta.baseIsNative, params, meta.baseDecimals, meta.quoteDecimals);
  }

  private get exec(): ExecCtx {
    return { publicClient: this.ctx.publicClient, walletClient: this.ctx.walletClient, account: this.ctx.account };
  }

  /** Human-unit tick / lot / min for sizing decisions. */
  get tick(): number { return fromRaw(this.params.tickSize, this.quoteDecimals); }
  get lot(): number { return fromRaw(this.params.lotSize, this.baseDecimals); }
  get minQty(): number { return fromRaw(this.params.minQuantity, this.baseDecimals); }

  async topOfBook(depth = 1): Promise<TopOfBook> {
    const [bids, asks] = await Promise.all([
      readBookLevels(this.ctx.publicClient, this.address, true, depth),
      readBookLevels(this.ctx.publicClient, this.address, false, depth),
    ]);
    const bestBid = bids[0] ? fromRaw(bids[0].priceRaw, this.quoteDecimals) : undefined;
    const bestAsk = asks[0] ? fromRaw(asks[0].priceRaw, this.quoteDecimals) : undefined;
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
    return { bestBid, bestAsk, mid };
  }

  async place(args: PlaceArgs): Promise<PlaceOrderResult> {
    const side = args.isBid ? "bid" : "ask";
    const priceRaw = alignToTick(toRaw(args.price, this.quoteDecimals), this.params.tickSize, side);
    const quantityRaw = alignToLot(toRaw(args.qty, this.baseDecimals), this.params.lotSize);
    const params = {
      pool: this.address,
      baseIsNative: this.baseIsNative,
      isBid: args.isBid,
      priceRaw,
      quantityRaw,
      tickRaw: this.params.tickSize,
      lotRaw: this.params.lotSize,
      minQtyRaw: this.params.minQuantity,
      orderType: args.orderType ?? ORDER_TYPE.ImmediateOrCancel,
      expireTimestampNs: buildExpireNs(args.expireMs ?? 60 * 60_000),
    };
    // Session-key mode: if an owner is set, place on their behalf as the operator.
    return this.ctx.owner ? placeOrderFor(this.exec, params, this.ctx.owner) : placeOrder(this.exec, params);
  }

  async cancel(orderId: bigint): Promise<`0x${string}`> {
    return this.ctx.owner
      ? cancelOrderFor(this.exec, this.address, this.ctx.owner, orderId)
      : cancelOrder(this.exec, this.address, orderId);
  }

  async openOrderIds(): Promise<bigint[]> {
    const ids = await this.ctx.publicClient.readContract({
      address: this.address,
      abi: SPOT_POOL_ABI,
      functionName: "getOwnOpenOrders",
      account: this.ctx.account,
    });
    return [...ids];
  }

  /** Withdrawable vault balance of the base side (uses the native sentinel for native pools). */
  async vaultBase(): Promise<number> {
    const token = this.baseIsNative ? (NATIVE_SENTINEL as `0x${string}`) : this.params.baseToken;
    const raw = await readWithdrawableBalance(this.ctx.publicClient, this.address, this.ctx.account.address, token);
    return fromRaw(raw, this.baseDecimals);
  }

  /**
   * Base held in the WALLET — ERC-20 `balanceOf`, or the native balance for a
   * native-base pool. Under the default auto-pull / auto-deliver mode fills
   * settle to the wallet (the vault reads ~0), so THIS is the number that
   * reflects live inventory for skew/hedging. Use `vaultBase()` only when you
   * run the market in manual-vault mode (`setManualVaultMode(true)`).
   */
  async walletBase(): Promise<number> {
    if (this.baseIsNative) {
      const raw = await this.ctx.publicClient.getBalance({ address: this.ctx.account.address });
      return fromRaw(raw, this.baseDecimals);
    }
    const raw = await this.ctx.publicClient.readContract({
      address: this.params.baseToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.ctx.account.address],
    });
    return fromRaw(raw, this.baseDecimals);
  }
}
