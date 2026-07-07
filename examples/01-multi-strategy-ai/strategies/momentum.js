/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export function analyzeMomentum(candles, trades, orderbook) {
  if (!candles || candles.length < 10) {
    return { strategy: 'MOMENTUM', signal: 'HOLD', confidence: 0, reason: 'Insufficient data' };
  }

  const mid = Math.floor(candles.length / 2);
  const recentCandles = candles.slice(-mid);
  const olderCandles = candles.slice(0, mid);

  const recentAvgClose =
    recentCandles.reduce((s, c) => s + c.close, 0) / recentCandles.length;
  const olderAvgClose =
    olderCandles.reduce((s, c) => s + c.close, 0) / olderCandles.length;
  const momentum = olderAvgClose > 0 ? (recentAvgClose - olderAvgClose) / olderAvgClose : 0;

  const recentHigh = Math.max(...recentCandles.map((c) => c.high));
  const currentPrice = candles[candles.length - 1].close;
  const isBreakout = currentPrice >= recentHigh * 0.998;

  const recentVolume = recentCandles.reduce((s, c) => s + (c.volume || 0), 0);
  const olderVolume = olderCandles.reduce((s, c) => s + (c.volume || 0), 0);
  const volumeRatio = olderVolume > 0 ? recentVolume / olderVolume : 1;

  const candleCount = candles.length;
  const upCandles = candles.slice(-candleCount).filter((c) => c.close > c.open).length;
  const upRatio = candleCount > 0 ? upCandles / candleCount : 0.5;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';
  let direction = momentum > 0.005 ? 'UP' : momentum < -0.005 ? 'DOWN' : 'SIDEWAYS';

  if (momentum > 0.01 && isBreakout && volumeRatio > 1.2 && upRatio > 0.55) {
    signal = 'BUY';
    confidence = Math.min(0.95, Math.abs(momentum) * 25 * volumeRatio);
    reason = `Strong breakout: ${(momentum * 100).toFixed(1)}% momentum, vol x${volumeRatio.toFixed(1)}, ${(upRatio * 100).toFixed(0)}% bullish candles`;
  } else if (momentum > 0.008 && upRatio > 0.6) {
    signal = 'BUY';
    confidence = Math.min(0.75, Math.abs(momentum) * 20);
    reason = `Upward trend: ${(momentum * 100).toFixed(1)}% momentum, ${(upRatio * 100).toFixed(0)}% bullish candles`;
  } else if (momentum < -0.01 && upRatio < 0.45) {
    signal = 'SELL';
    confidence = Math.min(0.80, Math.abs(momentum) * 18);
    reason = `Downward trend: ${(momentum * 100).toFixed(1)}% momentum, ${(upRatio * 100).toFixed(0)}% bullish candles`;
  } else {
    reason = `No clear momentum. Direction: ${direction}, momentum: ${(momentum * 100).toFixed(2)}%`;
  }

  return {
    strategy: 'MOMENTUM',
    signal,
    confidence,
    momentum,
    direction,
    isBreakout,
    volumeRatio,
    upRatio,
    reason,
  };
}
