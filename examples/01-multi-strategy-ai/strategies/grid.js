/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export function analyzeGrid(candles, orderbook, midPrice) {
  if (!candles || candles.length < 10) {
    return { strategy: 'GRID', signal: 'HOLD', confidence: 0, reason: 'Insufficient candle data' };
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeSize = rangeHigh - rangeLow;

  if (rangeSize <= 0 || rangeHigh <= 0) {
    return { strategy: 'GRID', signal: 'HOLD', confidence: 0, reason: 'No valid price range' };
  }

  const positionInRange = (midPrice - rangeLow) / rangeSize;

  const gridLevels = [
    rangeLow + rangeSize * 0.25,
    rangeLow + rangeSize * 0.50,
    rangeLow + rangeSize * 0.75,
  ];

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (positionInRange <= 0.25) {
    signal = 'BUY';
    confidence = Math.min(0.85, (0.25 - positionInRange) * 3.4);
    reason = `Price at ${(positionInRange * 100).toFixed(0)}% of range [${rangeLow.toFixed(6)} - ${rangeHigh.toFixed(6)}], near bottom`;
  } else if (positionInRange >= 0.75) {
    signal = 'SELL';
    confidence = Math.min(0.85, (positionInRange - 0.75) * 3.4);
    reason = `Price at ${(positionInRange * 100).toFixed(0)}% of range, near top`;
  } else {
    reason = `Mid-range (${(positionInRange * 100).toFixed(0)}%), waiting for better entry`;
  }

  const rangePercent = ((rangeSize / rangeLow) * 100);

  return {
    strategy: 'GRID',
    signal,
    confidence,
    rangeLow,
    rangeHigh,
    rangePercent,
    gridLevels,
    positionInRange,
    reason,
  };
}
