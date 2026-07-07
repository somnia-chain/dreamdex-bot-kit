/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export function analyzeCoinGeckoSentiment(btcData, ethData, btcRSI, ethRSI) {
  const btcPrice = btcData?.currentPrice || 0;
  const btcChange24h = btcData?.priceChange24h || 0;
  const ethPrice = ethData?.currentPrice || 0;
  const ethChange24h = ethData?.priceChange24h || 0;

  if (!btcData || !ethData) {
    return {
      strategy: 'COINGECKO_SENTIMENT',
      signal: 'NEUTRAL',
      confidence: 0,
      btcPrice,
      btcChange24h,
      btcRSI,
      ethPrice,
      ethChange24h,
      ethRSI,
      reason: 'No CoinGecko data available',
    };
  }

  const btcRsiVal = btcRSI !== null ? btcRSI : 50;
  const ethRsiVal = ethRSI !== null ? ethRSI : 50;

  // Bullish conditions
  const btcBullish = btcChange24h > 1.0 && btcRsiVal > 30 && btcRsiVal < 75;
  const ethBullish = ethChange24h > 1.0 && ethRsiVal > 30 && ethRsiVal < 75;

  // Bearish conditions
  const btcBearish = btcChange24h < -1.0 || btcRsiVal > 75;
  const ethBearish = ethChange24h < -1.0 || ethRsiVal > 75;

  // Strong bearish (oversold)
  const btcOversold = btcChange24h < -3.0 && btcRsiVal < 30;
  const ethOversold = ethChange24h < -3.0 && ethRsiVal < 30;

  let signal = 'NEUTRAL';
  let confidence = 0;
  let reasons = [];

  if (btcBullish && ethBullish) {
    signal = 'BULLISH';
    confidence = Math.min(0.90, (Math.abs(btcChange24h) + Math.abs(ethChange24h)) / 20 + 0.4);
    reasons.push(`BTC + ETH both bullish (${btcChange24h.toFixed(1)}%, ${ethChange24h.toFixed(1)}%)`);
  } else if (btcBearish && ethBearish) {
    signal = 'BEARISH';
    confidence = Math.min(0.85, (Math.abs(btcChange24h) + Math.abs(ethChange24h)) / 20 + 0.3);
    reasons.push(`BTC + ETH both bearish (${btcChange24h.toFixed(1)}%, ${ethChange24h.toFixed(1)}%)`);
  } else if (btcBullish || ethBullish) {
    signal = 'BULLISH';
    confidence = Math.min(0.70, Math.max(Math.abs(btcChange24h), Math.abs(ethChange24h)) / 20 + 0.3);
    if (btcBullish) reasons.push(`BTC bullish (${btcChange24h.toFixed(1)}%)`);
    if (ethBullish) reasons.push(`ETH bullish (${ethChange24h.toFixed(1)}%)`);
  } else if (btcBearish || ethBearish) {
    signal = 'BEARISH';
    confidence = Math.min(0.65, Math.max(Math.abs(btcChange24h), Math.abs(ethChange24h)) / 20 + 0.3);
    if (btcBearish) reasons.push(`BTC bearish (${btcChange24h.toFixed(1)}%)`);
    if (ethBearish) reasons.push(`ETH bearish (${ethChange24h.toFixed(1)}%)`);
  } else {
    reasons.push(`Mixed signals. BTC: ${btcChange24h.toFixed(1)}%, ETH: ${ethChange24h.toFixed(1)}%`);
  }

  // RSI context
  if (btcRsiVal > 75 || ethRsiVal > 75) {
    if (signal === 'BULLISH') {
      confidence *= 0.8;
      reasons.push('Warning: overbought RSI detected');
    }
  }
  if (btcRsiVal < 30 || ethRsiVal < 30) {
    if (signal === 'BEARISH') {
      confidence *= 0.8;
      reasons.push('Warning: oversold RSI - potential reversal');
    }
  }

  // Oversold bounce signal
  if (btcOversold || ethOversold) {
    if (signal === 'NEUTRAL') {
      signal = 'BULLISH';
      confidence = Math.min(0.60, 0.4);
      reasons.push('Oversold bounce signal');
    }
  }

  return {
    strategy: 'COINGECKO_SENTIMENT',
    signal,
    confidence: parseFloat(confidence.toFixed(2)),
    btcPrice,
    btcChange24h,
    btcRSI: btcRsiVal,
    ethPrice,
    ethChange24h,
    ethRSI: ethRsiVal,
    reason: reasons.join(' | ') || 'Neutral market conditions',
  };
}
