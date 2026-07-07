/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import 'dotenv/config';
import { Wallet, parseUnits, formatUnits } from 'ethers';
import { config } from './config.js';
import { DreamDexHttpClient } from '@trading/sdk';
import type { MarketInfo, PrepareOrderRequest, Side } from '@trading/sdk';
import { HttpOrderExecutor } from '@trading/sdk';
import { TransactionExecutor } from '@trading/sdk';
import { adjustPriceByBps, alignToStep } from '@trading/sdk';

const SWAP_AMOUNT_QUOTE = Number(process.env.DREAMDEX_SWAP_AMOUNT_QUOTE ?? '10');
const SLIPPAGE_BPS = Number(process.env.DREAMDEX_SWAP_SLIPPAGE_BPS ?? '5');
const CYCLE_MS = Number(process.env.DREAMDEX_SWAP_CYCLE_MS ?? '15000');
const GAS_RESERVE = Number(process.env.DREAMDEX_GAS_RESERVE ?? '0.02');

let running = true;
process.on('SIGINT', () => {
  console.log('\n[swap] Stopping after current cycle...');
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the base amount placed, or undefined if the order was skipped.
async function placeSide(
  side: Side,
  market: MarketInfo,
  bestBid: string | undefined,
  bestAsk: string | undefined,
  executor: HttpOrderExecutor,
  signer: TransactionExecutor,
  fixedBaseAmount?: string,
  effectiveQuoteAmount?: number,
): Promise<string | undefined> {
  const reference = side === 'buy' ? bestAsk : bestBid;
  if (!reference) {
    console.log(
      `[swap] No ${side === 'buy' ? 'ask' : 'bid'} in book — skipping ${side}`,
    );
    return undefined;
  }

  // Buyers cross the ask upward, sellers cross the bid downward.
  const price = alignToStep(
    adjustPriceByBps(reference, SLIPPAGE_BPS, side === 'buy' ? 'up' : 'down'),
    market.tickSize,
  );

  // For sells: use the exact amount from the preceding buy to avoid balance errors.
  // For buys: use effectiveQuoteAmount (capped to available balance) so chop-reduced
  // balances don't cause skipped cycles — the bot just trades a smaller clip.
  const quoteToUse = effectiveQuoteAmount ?? SWAP_AMOUNT_QUOTE;
  const baseAmount =
    fixedBaseAmount ??
    alignToStep(
      (quoteToUse / Number(reference)).toString(),
      market.lotSize,
    );

  if (Number(baseAmount) < Number(market.minQuantity)) {
    console.log(
      `[swap] Computed amount ${baseAmount} is below minimum ${market.minQuantity} — skipping ${side}`,
    );
    return undefined;
  }

  const request: PrepareOrderRequest = {
    walletAddress: config.walletAddress,
    type: 'limit',
    side,
    amount: baseAmount,
    price,
    fundingSource: config.fundingSource,
    orderType: 'immediateOrCancel',
    selfMatchingOption: config.selfMatchingOption,
  };

  console.log(
    `[swap] ${side.toUpperCase()} ${baseAmount} ${market.symbol} @ ${price}` +
      ` (book ${side === 'buy' ? 'ask' : 'bid'}=${reference}, slippage=${SLIPPAGE_BPS}bps)`,
  );

  if (config.dryRun) {
    console.log('[swap] Dry-run — skipping send');
    return baseAmount;
  }

  // Sell orders spend the base token — the API does not return an approval for
  // this direction, so approve the market contract to pull the base tokens first.
  if (side === 'sell') {
    const rawAmount = parseUnits(baseAmount, market.baseDecimals);
    const approvalHash = await signer.ensureErc20Allowance(
      market.base,
      market.contract,
      rawAmount,
    );
    if (approvalHash) {
      console.log(`[swap] Base token approval tx: ${approvalHash}`);
    }
  }

  try {
    const result = await executor.executeOrder(market, request);
    if (result.approvalTxHash) {
      console.log(`[swap] Approval tx: ${result.approvalTxHash}`);
    }
    console.log(`[swap] ${side.toUpperCase()} tx: ${result.txHash}`);
    return baseAmount;
  } catch (error) {
    console.error(
      `[swap] ${side.toUpperCase()} failed:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl,
    wallet,
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const signer = new TransactionExecutor(
    config.rpcUrl,
    config.privateKey,
    config.chainId,
  );
  const executor = new HttpOrderExecutor(http, signer);

  await signer.assertConnectedChain();

  const markets = await http.listMarkets();
  const market = markets.find((m) => m.symbol === config.symbol);
  if (!market) {
    throw new Error(`Market not found: ${config.symbol}`);
  }

  const isNativeSomi = market.symbol.startsWith('SOMI:');

  console.log(`[swap] Symbol      : ${market.symbol}`);
  console.log(
    `[swap] Tick/Lot    : ${market.tickSize} / ${market.lotSize} (min qty ${market.minQuantity})`,
  );
  console.log(`[swap] Amount      : ${SWAP_AMOUNT_QUOTE} quote per side`);
  console.log(`[swap] Slippage    : ${SLIPPAGE_BPS} bps`);
  console.log(`[swap] Cycle       : ${CYCLE_MS / 1000}s`);
  console.log(`[swap] Dry-run     : ${config.dryRun}`);
  if (isNativeSomi) {
    console.log(`[swap] Gas reserve : ${GAS_RESERVE} SOMI`);
  }

  let cycle = 0;

  while (running) {
    const cycleStart = Date.now();
    cycle++;
    console.log(`\n[swap] ─── Cycle ${cycle} ───`);

    // Check live balances to decide which side goes first this cycle.
    const [baseRaw, quoteRaw] = await Promise.all([
      isNativeSomi ? signer.getNativeBalance() : signer.getErc20Balance(market.base),
      signer.getErc20Balance(market.quote),
    ]);
    const baseBalance = Number(formatUnits(baseRaw, market.baseDecimals));
    const quoteBalance = Number(formatUnits(quoteRaw, market.quoteDecimals));
    const tradableBase = isNativeSomi ? Math.max(0, baseBalance - GAS_RESERVE) : baseBalance;

    // Effective buy size: cap to available quote so chop-reduced balances keep the
    // bot running with smaller clips rather than skipping cycles entirely.
    let effectiveQuote = Math.min(SWAP_AMOUNT_QUOTE, quoteBalance);

    // Fetch book first so canBuy uses the live ask to check affordability precisely.
    const book = await http.getOrderBook(market.symbol, 3);
    let bestBid = book?.bids[0]?.price;
    let bestAsk = book?.asks[0]?.price;

    const minQty = Number(market.minQuantity);
    // canBuy: quote must cover at least one minimum-sized buy at the live ask.
    // Using quoteBalance > 0 is too lenient — dust balances pass but the order fails.
    const canBuy = bestAsk ? effectiveQuote / Number(bestAsk) >= minQty : false;
    const canSell = tradableBase >= minQty;

    console.log(
      `[swap] Balances: base=${baseBalance.toFixed(4)} (tradable=${tradableBase.toFixed(4)}) quote=${quoteBalance.toFixed(4)}` +
        (effectiveQuote < SWAP_AMOUNT_QUOTE ? ` [using ${effectiveQuote.toFixed(4)} quote this cycle]` : '') +
        ` | canBuy=${canBuy} canSell=${canSell}`,
    );

    if (!canBuy && !canSell) {
      console.log('[swap] Insufficient balance on both sides — skipping cycle');
    } else {
      // When quote is too low to buy, sell existing base first to recover it.
      if (!canBuy && canSell) {
        const sellQty = alignToStep(tradableBase.toString(), market.lotSize);
        if (Number(sellQty) >= minQty) {
          console.log(`[swap] Quote depleted (${quoteBalance.toFixed(4)}) — selling ${sellQty} base to recover`);
          await placeSide('sell', market, bestBid, bestAsk, executor, signer, sellQty);
          if (!running) break;

          const [freshBook, freshQuoteRaw] = await Promise.all([
            http.getOrderBook(market.symbol, 3),
            signer.getErc20Balance(market.quote),
          ]);
          bestBid = freshBook?.bids[0]?.price ?? bestBid;
          bestAsk = freshBook?.asks[0]?.price ?? bestAsk;
          const freshQuote = Number(formatUnits(freshQuoteRaw, market.quoteDecimals));
          effectiveQuote = Math.min(SWAP_AMOUNT_QUOTE, freshQuote);
          console.log(`[swap] Recovered quote: ${freshQuote.toFixed(4)}`);
        }
      }

      // Buy leg — only if quote is sufficient.
      const canBuyNow = bestAsk ? effectiveQuote / Number(bestAsk) >= minQty : false;
      if (!canBuyNow) {
        console.log(`[swap] Insufficient quote (${effectiveQuote.toFixed(4)}) — skipping buy`);
      } else {
        const boughtAmount = await placeSide('buy', market, bestBid, bestAsk, executor, signer, undefined, effectiveQuote);
        if (running && boughtAmount) {
          // Read live base balance right before the sell so the sell quantity reflects
          // the actual wallet state — this drains any residual base left by prior
          // partial IOC sell fills in addition to what was just bought.
          const baseNowRaw = isNativeSomi
            ? await signer.getNativeBalance()
            : await signer.getErc20Balance(market.base);
          const baseNow = Number(formatUnits(baseNowRaw, market.baseDecimals));
          const tradableNow = isNativeSomi ? Math.max(0, baseNow - GAS_RESERVE) : baseNow;
          const sellQty = alignToStep(tradableNow.toString(), market.lotSize);

          if (Number(sellQty) < minQty) {
            console.log(`[swap] Buy fill too small to sell (${sellQty}) — will recover next cycle`);
          } else {
            if (Number(sellQty) > Number(boughtAmount)) {
              console.log(`[swap] Selling full balance ${sellQty} (buy filled ${boughtAmount}, +${(Number(sellQty) - Number(boughtAmount)).toFixed(5)} prior residual)`);
            }
            const freshBook = await http.getOrderBook(market.symbol, 3);
            bestBid = freshBook?.bids[0]?.price ?? bestBid;
            bestAsk = freshBook?.asks[0]?.price ?? bestAsk;
            await placeSide('sell', market, bestBid, bestAsk, executor, signer, sellQty);
          }
        }
      }
    }

    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, CYCLE_MS - elapsed);
    if (running && wait > 0) {
      console.log(`[swap] Next cycle in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  console.log('[swap] Stopped.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
