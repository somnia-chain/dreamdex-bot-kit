/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Throttled status logging.
//
// Signal-driven strategies (grid, momentum, mean-reversion) do nothing until the
// market gives them a reason to. That is correct behaviour, but a bot that
// prints one line at startup and then stays silent for ten minutes is
// indistinguishable from a bot that is broken — which is exactly what a first
// dry-run looks like.
//
// A status logger fixes that: strategies call it every tick with what they are
// currently seeing and waiting for, and it prints at most once per interval.
//
//   const status = createStatusLogger(log);
//   status(`mid=${mid} waiting for ask ≤ ${trigger}`);
//
// Interval comes from STATUS_LOG_MS (default 30s). Set STATUS_LOG_MS=0 to turn
// status lines off entirely; real events (orders, fills, errors) are logged by
// the strategies themselves and are never throttled.

const DEFAULT_INTERVAL_MS = 30_000;

export function createStatusLogger(
  log: (msg: string) => void,
  defaultIntervalMs: number = DEFAULT_INTERVAL_MS,
): (msg: string) => void {
  const raw = process.env.STATUS_LOG_MS;
  const parsed = raw === undefined || raw === "" ? defaultIntervalMs : Number(raw);
  const intervalMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultIntervalMs;

  let lastMs = 0;
  return (msg: string): void => {
    if (intervalMs === 0) return;
    const now = Date.now();
    // First call always prints, so you see the bot is alive right away.
    if (lastMs !== 0 && now - lastMs < intervalMs) return;
    lastMs = now;
    log(msg);
  };
}
