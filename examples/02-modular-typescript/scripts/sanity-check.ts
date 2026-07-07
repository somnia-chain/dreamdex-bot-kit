/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { logger } from "../src/utils/logger.js";
import { getChainContext } from "../src/utils/signer.js";
import {
  getPoolHandle,
  readBookLevels,
  readPoolParams,
  readWithdrawableBalance,
  getErc20,
} from "../src/dex/contracts.js";
import { DreamDexRestClient } from "../src/dex/rest.js";
import { DreamDexWsClient } from "../src/dex/websocket.js";
import { getToken } from "../src/config/tokens.js";
import { fromRaw, fromRawAsNumber } from "../src/utils/decimals.js";

type CheckStatus = "ok" | "fail" | "skip";
type CheckResult = { name: string; status: CheckStatus; detail?: string };

const results: CheckResult[] = [];

function record(name: string, status: CheckStatus, detail?: string): void {
  results.push({ name, status, detail });
  const tag = status === "ok" ? "✓" : status === "skip" ? "○" : "✗";
  const msg = detail ? `${tag} ${name} — ${detail}` : `${tag} ${name}`;
  if (status === "ok") logger.info(msg);
  else if (status === "skip") logger.warn(msg);
  else logger.error(msg);
}

async function checkRpc(): Promise<void> {
  try {
    const ctx = await getChainContext();
    const block = await ctx.provider.getBlockNumber();
    record("RPC connection", "ok", `chainId=${ctx.network.chainId} block=${block}`);
  } catch (err) {
    record("RPC connection", "fail", (err as Error).message);
    throw err;
  }
}

async function checkWalletBalance(): Promise<void> {
  const ctx = await getChainContext();
  if (!ctx.wallet) {
    record("Wallet balance", "skip", "PRIVATE_KEY not set");
    return;
  }
  try {
    const native = await ctx.provider.getBalance(ctx.wallet.address);
    const usdsoToken = getToken(ctx.network.name, "USDso");
    const usdso = await getErc20(usdsoToken.address);
    const usdsoBal: bigint = await usdso.balanceOf(ctx.wallet.address);
    record(
      "Wallet balance",
      "ok",
      `native=${fromRaw(native, 18)} ${ctx.network.nativeSymbol} | USDso=${fromRaw(usdsoBal, usdsoToken.decimals)}`,
    );
  } catch (err) {
    record("Wallet balance", "fail", (err as Error).message);
  }
}

async function checkPoolViaRpc(symbol: string): Promise<void> {
  try {
    const handle = await getPoolHandle(symbol);
    const params = await readPoolParams(handle);
    const tick = Number(ethers.formatUnits(params.tickSize, handle.quoteToken.decimals));
    const lot = Number(ethers.formatUnits(params.lotSize, handle.baseToken.decimals));
    record(
      `Pool ${symbol} params (RPC)`,
      "ok",
      `tickRaw=${params.tickSize} lotRaw=${params.lotSize} → tick≈${tick} lot≈${lot}`,
    );

    const book = await readBookLevels(handle, 3);
    const topBid = book.bids[0];
    const topAsk = book.asks[0];
    const bidStr = topBid ? `${topBid.price.toFixed(6)} × ${topBid.size}` : "empty";
    const askStr = topAsk ? `${topAsk.price.toFixed(6)} × ${topAsk.size}` : "empty";
    record(
      `Pool ${symbol} order book (RPC)`,
      "ok",
      `top bid=${bidStr} | top ask=${askStr}`,
    );

    const ctx = await getChainContext();
    if (ctx.wallet) {
      const balQuote = await readWithdrawableBalance(
        handle,
        ctx.wallet.address,
        handle.quoteToken.address,
      );
      const balBase = await readWithdrawableBalance(
        handle,
        ctx.wallet.address,
        handle.baseToken.address,
      );
      record(
        `Vault balance on ${symbol}`,
        "ok",
        `${handle.baseToken.symbol}=${fromRawAsNumber(balBase, handle.baseToken.decimals)} | ${handle.quoteToken.symbol}=${fromRawAsNumber(balQuote, handle.quoteToken.decimals)}`,
      );
    }
  } catch (err) {
    record(`Pool ${symbol} (RPC)`, "fail", (err as Error).message);
  }
}

async function checkRest(symbol: string): Promise<void> {
  const rest = new DreamDexRestClient();
  try {
    const markets = await rest.getMarkets();
    record("REST /markets", "ok", `${markets.length} markets`);
  } catch (err) {
    record("REST /markets", "fail", (err as Error).message);
  }

  try {
    const book = await rest.getOrderBook(symbol);
    const topBid = book.bids[0];
    const topAsk = book.asks[0];
    const bidStr = topBid ? `${topBid.price} × ${topBid.size}` : "empty";
    const askStr = topAsk ? `${topAsk.price} × ${topAsk.size}` : "empty";
    record(
      `REST /orderbooks?symbols=${symbol}`,
      "ok",
      `top bid=${bidStr} | top ask=${askStr}`,
    );
  } catch (err) {
    record(`REST /orderbooks?symbols=${symbol}`, "fail", (err as Error).message);
  }
}

async function checkWebSocket(symbol: string): Promise<void> {
  const ws = new DreamDexWsClient();
  let received = 0;
  const unsub = ws.onMessage(() => {
    received += 1;
  });
  try {
    await ws.connect();
    ws.subscribe("orderbook", { symbols: [symbol] });
    await new Promise((r) => setTimeout(r, 5_000));
    record(
      `WebSocket subscribe ${symbol}`,
      received > 0 ? "ok" : "fail",
      received > 0
        ? `received ${received} message(s) in 5s`
        : "no messages received in 5s — check channel name or symbol format",
    );
  } catch (err) {
    record(`WebSocket subscribe ${symbol}`, "fail", (err as Error).message);
  } finally {
    unsub();
    ws.close();
  }
}

async function main(): Promise<void> {
  logger.info("Starting DreamTend sanity-check…");
  await checkRpc();
  await checkWalletBalance();

  const ctx = await getChainContext();
  const probePair = ctx.network.name === "mainnet" ? "USDC.e:USDso" : "SOMI:USDso";

  await checkPoolViaRpc(probePair);
  await checkRest(probePair);
  await checkWebSocket(probePair);

  const fails = results.filter((r) => r.status === "fail");
  const okCount = results.filter((r) => r.status === "ok").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  logger.info(
    `Sanity check complete: ${okCount} ok, ${skipCount} skip, ${fails.length} fail (of ${results.length} total)`,
  );
  if (fails.length > 0) {
    logger.error("Some checks failed — see above for details.");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Sanity check crashed");
  process.exit(1);
});
