/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + (changes[i] > 0 ? changes[i] : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;

  const sma = calculateSMA(closes, period);
  if (sma === null) return null;

  const slice = closes.slice(-period);
  const variance =
    slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: sma + multiplier * stdDev,
    middle: sma,
    lower: sma - multiplier * stdDev,
    width: ((2 * multiplier * stdDev) / sma) * 100,
  };
}

export function analyzeMeanReversion(candles, currentPrice) {
  if (!candles || candles.length < 15) {
    return { strategy: 'MEAN_REVERSION', signal: 'HOLD', confidence: 0, reason: 'Insufficient data' };
  }

  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, 14);
  const bb = calculateBollingerBands(closes, 20, 2);
  const sma20 = calculateSMA(closes, 20);

  let signal = 'HOLD';
  let confidence = 0;
  let zone = 'NEUTRAL';
  let reason = '';

  const priceVsSMA = sma20 ? (currentPrice - sma20) / sma20 : 0;

  if (rsi <= 25) {
    zone = 'OVERSOLD';
    signal = 'BUY';
    confidence = Math.min(0.90, (30 - rsi) / 20);
    reason = `RSI severely oversold at ${rsi.toFixed(1)}`;
  } else if (rsi <= 35) {
    zone = 'NEAR_OVERSOLD';
    const isNearLowerBand = bb && currentPrice <= bb.lower * 1.03;
    if (isNearLowerBand) {
      signal = 'BUY';
      confidence = Math.min(0.75, (35 - rsi) / 30);
      reason = `RSI ${rsi.toFixed(1)} near oversold + price near lower band`;
    } else {
      reason = `RSI ${rsi.toFixed(1)} approaching oversold, but no band confirmation`;
    }
  } else if (rsi >= 75) {
    zone = 'OVERBOUGHT';
    signal = 'SELL';
    confidence = Math.min(0.90, (rsi - 70) / 20);
    reason = `RSI severely overbought at ${rsi.toFixed(1)}`;
  } else if (rsi >= 65) {
    zone = 'NEAR_OVERBOUGHT';
    const isNearUpperBand = bb && currentPrice >= bb.upper * 0.97;
    if (isNearUpperBand) {
      signal = 'SELL';
      confidence = Math.min(0.75, (rsi - 60) / 30);
      reason = `RSI ${rsi.toFixed(1)} near overbought + price near upper band`;
    } else {
      reason = `RSI ${rsi.toFixed(1)} approaching overbought`;
    }
  } else {
    reason = `RSI neutral at ${rsi.toFixed(1)}`;
  }

  return {
    strategy: 'MEAN_REVERSION',
    signal,
    confidence,
    rsi,
    zone,
    sma20,
    bollingerBands: bb,
    priceVsSMA,
    reason,
  };
}
