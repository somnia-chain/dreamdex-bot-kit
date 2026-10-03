# Backtesting strategies

Replay any kit strategy against historical DreamDEX OHLCV candles before risking capital.

The engine lives in [`packages/backtest`](../packages/backtest) (`@dreamdex-bot-kit/backtest`).
Each strategy owns a small typed adapter at `strategies/<name>/src/backtest.ts` so constructor
and config changes break the build instead of failing at runtime.

## Quick start

```bash
# Compare all bots on the same candle window
npm run backtest -- review --symbol WETH:USDso --interval 5m --days 7

# Single strategy
npm run backtest -- run momentum --symbol WETH:USDso --interval 1m --days 3

# Override strategy knobs without editing .env
npm run backtest -- run grid --set stepBps=20 --set lotUsdso=10 --quiet

# Export reports
npm run backtest -- review --days 7 --out report.json --csv report.csv
```

Candles are cached under `.cache/candles/` (gitignored). Pass `--no-cache` to force a fresh fetch.

## CLI

```
npm run backtest -- review [options]
npm run backtest -- run <bot> [options]
```

**Bots:** `momentum`, `mean-reversion`, `grid`, `market-making`, `twap`, `starter`, `ensemble`, `treasury`, `yield-optimizer`

| Flag | Default | Meaning |
| --- | --- | --- |
| `--symbol` | `WETH:USDso` | Market |
| `--interval` | `5m` | `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d` |
| `--days` | `7` | Lookback (ignored if `--since` set) |
| `--since` / `--until` | — / now | Explicit ms timestamps |
| `--network` | `mainnet` | `mainnet` \| `testnet` |
| `--bots` | `all` | review only: comma list or `all` |
| `--spread-bps` | `10` | Synthetic full spread in bps |
| `--quote-usdso` / `--base` | `1000` / `0` | Starting balances |
| `--taker-fee-bps` / `--maker-fee-bps` / `--slippage-bps` | `0` | Cost model |
| `--calibrate-live` | off | Set spread from live orderbook once |
| `--depth-dir` | — | Overlay recorded depth JSON snapshots |
| `--queue-position` | off | Volume/queue-aware partial maker fills |
| `--markout-bars` | `5` | Maker markout horizon (`0` = off) |
| `--set key=value` | — | Repeatable strategy config override |
| `--no-cache` | off | Skip disk candle cache |
| `--out` / `--csv` | — | Write JSON / CSV metrics |
| `--quiet` | off | Suppress per-bar strategy logs |

## Simulation model

Bar-by-bar (not tick/event driven):

1. Fake `Date.now()` to the candle timestamp
2. Build a synthetic top-of-book from candle close (or hl2) ± spread
3. Match resting maker orders against the bar's high/low
4. Call the strategy's `onBar()` (which calls `tick()` / `onBook()` / `slice()` / …)
5. Mark equity at bar close

`SimPool` implements the same surface strategies use live: `topOfBook`, `place`, `cancel`, `walletBase`.
Adapters force `dryRun: false` so orders hit the simulator (live dry-run only logs).

### What is modeled

- IOC / FOK / PostOnly / GTC order types
- Maker and taker fees, taker slippage
- Optional queue-position partial fills (`--queue-position`)
- Maker markout reporting (does not affect PnL)

### Limitations (read these)

- **No historical CLOB** — book is synthetic from OHLCV unless you supply `--depth-dir`.
  (Real order-level history does exist — `scripts/order-history.ts` pulls market-wide
  orders + fills from the markets indexer — but the replay itself still synthesizes the book.)
- **No gas** — `gasUsed` is always `0`
- **Bar timing** — one strategy callback per candle; MM cooldowns are zeroed for replay
- **No silent on-chain rejections** beyond PostOnly cross / FOK / minQty
- For post-live fill quality, use [`tools/edge-analytics`](../tools/edge-analytics)

## Writing an adapter for a custom strategy

1. Add a dependency on `@dreamdex-bot-kit/backtest` in the strategy `package.json`.
2. Export `createBacktestBot` from `src/backtest.ts`:

```ts
import {
  applyConfigOverrides,
  asPool,
  type BotFactory,
} from "@dreamdex-bot-kit/backtest";
import type { Pool } from "@dreamdex-bot-kit/core";
import { MyStrategy } from "./strategy.js";
import { config, type Config } from "./config.js";

export function createBacktestBot(overrides: Record<string, unknown> = {}): BotFactory {
  return async (pool, log) => {
    const cfg = applyConfigOverrides(
      { ...config, symbol: pool.symbol, dryRun: false } as Config & Record<string, unknown>,
      overrides,
    ) as Config;
    const bot = new MyStrategy(asPool<Pool>(pool), cfg, log);
    return {
      warmupBars: 20,
      async onBar() {
        await bot.tick();
      },
    };
  };
}
```

3. Register the bot id in [`scripts/backtest.ts`](../scripts/backtest.ts) (`BOT_IDS` + `loadAdapter`).

Strategies that only use `topOfBook` / `place` / `cancel` / `walletBase` work with minimal changes.
Anything that needs `openOrderIds()`, vault balances, or real WebSocket book updates needs extra adapter work.

## Programmatic API

```ts
import { backtest, reviewBots } from "@dreamdex-bot-kit/backtest";
import { createBacktestBot } from "../strategies/momentum/src/backtest.js";

const result = await backtest({
  label: "momentum",
  createBot: createBacktestBot({ windowSize: 30 }),
  symbol: "WETH:USDso",
  interval: "5m",
  since: Date.now() - 7 * 86_400_000,
});
```

## Ensemble notes

`ensemble` is driven via `Orchestrator.startBacktest()` + one public `cycle()` per bar.
AI fusion is forced off (`features.ai = false`) so runs stay deterministic and offline.
