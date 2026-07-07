/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { SPOTPOOL_ABI } from "./abi/spotpool.js";
import { ERC20_ABI } from "./abi/erc20.js";
import type { SpotPoolContract, Erc20Contract } from "./abi/types.js";
import { getChainContext } from "../utils/signer.js";
import { getPool, type PoolConfig } from "../config/pairs.js";
import { getToken, type TokenInfo } from "../config/tokens.js";
import { rawToPrice, rawToQty } from "../utils/price.js";
import type { NetworkName } from "../config/network.js";

export interface PoolHandle {
  pool: PoolConfig;
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  contract: SpotPoolContract;
  readonly: SpotPoolContract;
}

export async function getPoolHandle(symbol: string): Promise<PoolHandle> {
  const ctx = await getChainContext();
  const pool = getPool(ctx.network.name, symbol);
  const baseToken = getToken(ctx.network.name, pool.base);
  const quoteToken = getToken(ctx.network.name, pool.quote);

  const readonlyBase = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, ctx.provider);
  const readonly = readonlyBase as SpotPoolContract;
  const contract = (ctx.wallet
    ? (readonlyBase.connect(ctx.wallet) as ethers.Contract)
    : readonlyBase) as SpotPoolContract;

  return { pool, baseToken, quoteToken, contract, readonly };
}

export async function getErc20(tokenAddress: string): Promise<Erc20Contract> {
  const ctx = await getChainContext();
  const ro = new ethers.Contract(tokenAddress, ERC20_ABI, ctx.provider);
  const bound = ctx.wallet ? (ro.connect(ctx.wallet) as ethers.Contract) : ro;
  return bound as Erc20Contract;
}

export async function getErc20For(network: NetworkName, symbol: string): Promise<Erc20Contract> {
  const token = getToken(network, symbol);
  return getErc20(token.address);
}

export interface BookLevels {
  bids: Array<{ price: number; size: number; priceRaw: bigint; sizeRaw: bigint }>;
  asks: Array<{ price: number; size: number; priceRaw: bigint; sizeRaw: bigint }>;
}

export async function readBookLevels(
  handle: PoolHandle,
  depth = 5,
): Promise<BookLevels> {
  const safeRead = async (isBid: boolean): Promise<[bigint[], bigint[]]> => {
    try {
      const [prices, sizes]: [bigint[], bigint[]] =
        await handle.readonly.getBookLevels(isBid, depth);
      return [prices, sizes];
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("require(false)") || msg.includes("CALL_EXCEPTION")) {
        return [[], []];
      }
      throw err;
    }
  };

  const [bidPricesRaw, bidSizesRaw] = await safeRead(true);
  const [askPricesRaw, askSizesRaw] = await safeRead(false);

  const baseDec = handle.baseToken.decimals;
  const quoteDec = handle.quoteToken.decimals;

  const mapSide = (prices: bigint[], sizes: bigint[]) =>
    prices.map((p, i) => ({
      priceRaw: p,
      sizeRaw: sizes[i] ?? 0n,
      price: rawToPrice(p, quoteDec),
      size: rawToQty(sizes[i] ?? 0n, baseDec),
    }));

  return {
    bids: mapSide(bidPricesRaw, bidSizesRaw),
    asks: mapSide(askPricesRaw, askSizesRaw),
  };
}

export interface PoolParamsOnchain {
  baseToken: string;
  quoteToken: string;
  makerFeeBpsTimes1k: bigint;
  takerFeeBpsTimes1k: bigint;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
}

export async function readPoolParams(handle: PoolHandle): Promise<PoolParamsOnchain> {
  const result = await handle.readonly.getPoolParams();
  return {
    baseToken: result[0],
    quoteToken: result[1],
    makerFeeBpsTimes1k: result[2],
    takerFeeBpsTimes1k: result[3],
    tickSize: result[4],
    lotSize: result[5],
    minQuantity: result[6],
  };
}

export async function readWithdrawableBalance(
  handle: PoolHandle,
  account: string,
  tokenAddress: string,
): Promise<bigint> {
  return handle.readonly.getWithdrawableBalance(account, tokenAddress);
}

export async function readOwnOpenOrders(
  handle: PoolHandle,
  account: string,
): Promise<bigint[]> {
  return handle.readonly.getOwnOpenOrders(account);
}
