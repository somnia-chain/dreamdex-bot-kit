/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

function decimalPlaces(value: string): number {
  const [, decimals = ''] = value.split('.');
  return decimals.length;
}

function toScaledInteger(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  const paddedFraction = (fraction + '0'.repeat(scale)).slice(0, scale);
  return BigInt(`${whole}${paddedFraction}`);
}

function fromScaledInteger(value: bigint, scale: number): string {
  if (scale === 0) {
    return value.toString();
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const raw = absolute.toString().padStart(scale + 1, '0');
  const whole = raw.slice(0, -scale);
  const fraction = raw.slice(-scale).replace(/0+$/, '');
  const rendered = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}

export function alignToStep(value: string, step: string): string {
  const scale = Math.max(decimalPlaces(value), decimalPlaces(step));
  const scaledValue = toScaledInteger(value, scale);
  const scaledStep = toScaledInteger(step, scale);

  if (scaledStep <= 0n) {
    throw new Error(`Invalid step size: ${step}`);
  }

  const floored = (scaledValue / scaledStep) * scaledStep;
  return fromScaledInteger(floored, scale);
}

export function adjustPriceByBps(
  value: string,
  bps: number,
  direction: 'up' | 'down',
): string {
  const scale = Math.max(decimalPlaces(value), 6);
  const scaledValue = toScaledInteger(value, scale);
  const precision = 1_000;
  const multiplier = direction === 'up' ? 10_000 + bps : 10_000 - bps;
  const numerator = BigInt(Math.round(multiplier * precision));
  const denominator = 10_000n * BigInt(precision);
  const adjusted = (scaledValue * numerator) / denominator;
  return fromScaledInteger(adjusted, scale);
}
