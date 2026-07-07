/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Contract, Wallet, formatUnits, parseUnits } from 'ethers';
import { config } from './config.js';
import { DreamDexHttpClient } from '@trading/sdk';
import type { MarketInfo, PrepareOrderRequest, Side } from '@trading/sdk';
import { HttpOrderExecutor } from '@trading/sdk';
import { TransactionExecutor } from '@trading/sdk';
import { adjustPriceByBps, alignToStep } from '@trading/sdk';

const POOL_ABI = [
  'function getWithdrawableBalance(address user, address token) view returns (uint256)',
  'function withdraw(address token, uint256 amount)',
] as const;

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
] as const;

function getSideFromArgs(): Side {
  const side = process.argv[2];
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('Usage: tsx src/scripts/http-order.ts <buy|sell>');
  }

  return side;
}

function getRequestedSymbol(): string {
  return process.env.DREAMDEX_TEST_SYMBOL ?? config.symbol;
}

function getRequestedAmount(): string {
  return process.env.DREAMDEX_TEST_AMOUNT ?? config.orderAmount;
}

function shouldAutoWithdraw(): boolean {
  return (process.env.DREAMDEX_TEST_AUTO_WITHDRAW ?? 'true') === 'true';
}

function getSlippageBps(): number {
  const slippageBps = Number(process.env.DREAMDEX_TEST_SLIPPAGE_BPS ?? '25');
  if (Number.isNaN(slippageBps) || slippageBps < 0) {
    throw new Error('DREAMDEX_TEST_SLIPPAGE_BPS must be a non-negative number');
  }

  return slippageBps;
}

function resolvePrice(
  side: Side,
  market: MarketInfo,
  bestBid?: string,
  bestAsk?: string,
): string {
  const override = process.env.DREAMDEX_TEST_PRICE;
  if (override) {
    return alignToStep(override, market.tickSize);
  }

  const slippageBps = getSlippageBps();
  const reference = side === 'buy' ? bestAsk : bestBid;
  if (!reference) {
    throw new Error(
      'No price override was provided and the order book did not contain the required best price.',
    );
  }

  const adjusted =
    side === 'buy'
      ? adjustPriceByBps(reference, slippageBps, 'up')
      : adjustPriceByBps(reference, slippageBps, 'down');

  return alignToStep(adjusted, market.tickSize);
}

function buildRequest(
  side: Side,
  market: MarketInfo,
  price: string,
  amount: string,
): PrepareOrderRequest {
  const alignedAmount = alignToStep(amount, market.lotSize);
  if (Number(alignedAmount) < Number(market.minQuantity)) {
    throw new Error(
      `Requested amount ${alignedAmount} is below market minimum ${market.minQuantity}`,
    );
  }

  return {
    walletAddress: config.walletAddress,
    type: 'limit',
    side,
    amount: alignedAmount,
    price,
    fundingSource: config.fundingSource,
    orderType: config.orderType,
    selfMatchingOption: config.selfMatchingOption,
  };
}

async function main(): Promise<void> {
  const side = getSideFromArgs();
  const symbol = getRequestedSymbol();
  const amount = getRequestedAmount();
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl,
    wallet,
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const executor = new TransactionExecutor(
    config.rpcUrl,
    config.privateKey,
    config.chainId,
  );
  const httpExecutor = new HttpOrderExecutor(http, executor);

  await executor.assertConnectedChain();

  const markets = await http.listMarkets();
  const market = markets.find((item) => item.symbol === symbol);
  if (!market) {
    throw new Error(`Market not found: ${symbol}`);
  }

  const orderBook = await http.getOrderBook(symbol, 5);
  console.log(orderBook);
  const bestBid = orderBook?.bids[0]?.price;
  const bestAsk = orderBook?.asks[0]?.price;
  const price = resolvePrice(side, market, bestBid, bestAsk);
  const request = buildRequest(side, market, price, amount);

  console.log(`[http-test] Symbol=${symbol}`);
  console.log(`[http-test] Side=${side}`);
  console.log(`[http-test] Funding=${request.fundingSource}`);
  console.log(`[http-test] OrderType=${request.orderType}`);
  console.log(`[http-test] Amount=${request.amount}`);
  console.log(`[http-test] Price=${request.price}`);
  console.log(
    `[http-test] SlippageBps=${getSlippageBps()} (used only when DREAMDEX_TEST_PRICE is unset)`,
  );
  console.log(`[http-test] AutoWithdraw=${shouldAutoWithdraw()}`);
  if (bestBid || bestAsk) {
    console.log(
      `[http-test] Book best bid=${bestBid ?? 'n/a'} best ask=${bestAsk ?? 'n/a'}`,
    );
  }

  if (
    symbol === 'SOMI:USDso' &&
    request.fundingSource === 'wallet' &&
    side === 'sell'
  ) {
    console.log(
      '[http-test] Native SOMI sell detected: HTTP mode should return an unsigned transaction that sends native value for the sell amount.',
    );
  }

  const pool = new Contract(market.contract, POOL_ABI, executor.getSigner());
  const quoteToken = new Contract(market.quote, ERC20_ABI, executor.getSigner());

  const isNativeSomi = symbol.startsWith('SOMI:');
  const walletBaseBefore = isNativeSomi
    ? await executor.getNativeBalance()
    : (await new Contract(market.base, ERC20_ABI, executor.getSigner()).balanceOf(config.walletAddress) as bigint);
  const walletQuoteBefore = await quoteToken.balanceOf(config.walletAddress) as bigint;

  console.log(`[http-test] Wallet base  balance before=${formatUnits(walletBaseBefore, market.baseDecimals)}`);
  console.log(`[http-test] Wallet quote balance before=${formatUnits(walletQuoteBefore, market.quoteDecimals)}`);

  // Pre-flight balance check — catch insufficient funds before hitting the chain.
  const neededBase  = parseUnits(request.amount, market.baseDecimals);
  const neededQuote = parseUnits(
    (Number(request.amount) * Number(request.price)).toFixed(market.quoteDecimals),
    market.quoteDecimals,
  );

  if (side === 'sell' && walletBaseBefore < neededBase) {
    throw new Error(
      `Insufficient base balance: need ${request.amount} but wallet has ${formatUnits(walletBaseBefore, market.baseDecimals)}`,
    );
  }
  if (side === 'buy' && walletQuoteBefore < neededQuote) {
    throw new Error(
      `Insufficient quote balance: need ${formatUnits(neededQuote, market.quoteDecimals)} but wallet has ${formatUnits(walletQuoteBefore, market.quoteDecimals)}`,
    );
  }

  if (config.dryRun) {
    console.log(
      '[dry-run] Skipping HTTP order execution. Set DREAMDEX_DRY_RUN=false to send.',
    );
    return;
  }

  // ERC-20 sells need an approval so the contract can pull the base token.
  // Native SOMI sells send msg.value directly — no approval contract exists.
  if (side === 'sell' && !isNativeSomi) {
    const rawAmount = parseUnits(request.amount, market.baseDecimals);
    const approvalHash = await executor.ensureErc20Allowance(market.base, market.contract, rawAmount);
    if (approvalHash) {
      console.log(`[http-test] Base token approval tx: ${approvalHash}`);
    }
  }

  const result = await httpExecutor.executeOrder(market, request);

  if (result.approvalTxHash) {
    console.log(`[http-test] Approval tx hash: ${result.approvalTxHash}`);
  }
  console.log(`[http-test] HTTP order tx hash: ${result.txHash}`);

  const withdrawableQuote = (await pool.getWithdrawableBalance(
    config.walletAddress,
    market.quote,
  )) as bigint;
  console.log(
    `[http-test] Withdrawable quote balance after fill=${formatUnits(withdrawableQuote, market.quoteDecimals)}`,
  );

  if (shouldAutoWithdraw() && withdrawableQuote > 0n) {
    console.log(
      '[http-test] Withdrawing quote token from pool vault to wallet...',
    );
    const withdrawTx = await pool.withdraw(market.quote, withdrawableQuote);
    const withdrawReceipt = await withdrawTx.wait();
    if (!withdrawReceipt) {
      throw new Error(
        'Withdraw transaction broadcasted but no receipt was returned',
      );
    }
    console.log(`[http-test] Withdraw tx hash: ${withdrawReceipt.hash}`);
  }

  const walletQuoteAfter = (await quoteToken.balanceOf(
    config.walletAddress,
  )) as bigint;
  console.log(
    `[http-test] Wallet quote balance after=${formatUnits(walletQuoteAfter, market.quoteDecimals)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
