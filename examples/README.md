# Examples — real bots from the first DreamDEX competition

These are the actual trading bots teams ran in DreamDEX competitions and the Dev Traders Program, **curated to
their genuine trading-strategy code** and **anonymized**. Reports, findings docs, run logs,
compiled binaries, dashboards, secrets, and personal identifiers have been stripped — and so has
any pure volume-generation / wash-trade tooling. What's left is real trading logic you can learn
from: market-making, grid, momentum, mean-reversion, and multi-pair strategies.

They're here to **read and learn from**, not as blessed reference implementations. For the clean,
modern, runnable versions of these ideas, use [`../strategies`](../strategies) and
[`../packages/core`](../packages/core) — this folder is the raw material those were distilled from.

## Read this first

> **Most of these bots predate the June 2026 contract upgrade ** and call the removed
> `placeTakerOrderWithoutVault`. When adapting any of this code, that's the #1 thing to modernize —
> replace it with the `payable` `placeOrder` (see [`../docs/architecture.md`](../docs/architecture.md)
> and [`../docs/gotchas.md`](../docs/gotchas.md#1-placetakerorderwithoutvault-is-gone)). Some also
> compute the old 5-argument `OrderFilled` topic, which no longer matches.

The bots that used the **HTTP-prepare** path (the server builds the calldata) were naturally
insulated from that break; the ones that call the contract directly are the ones that need the fix.

## The bots

| Folder | Lang | Strategy & standout technique |
| --- | --- | --- |
| [`01-multi-strategy-ai`](01-multi-strategy-ai) | JS | An LLM-driven decision bot over a classical strategy ensemble — grid, momentum, RSI+Bollinger mean-reversion, and a sentiment signal. HTTP-prepare. |
| [`02-modular-typescript`](02-modular-typescript) | TS | The cleanest architecture: a dedicated **gotcha-guard module** and a **safe-broadcast** lifecycle (simulate → broadcast → read the real orderId from the receipt), plus an inventory-skew market maker. The model for `packages/core`. |
| [`03-monorepo-grid`](03-monorepo-grid) | TS | A pnpm/turbo monorepo (SDK + bot). Home of the best **grid** implementation: FIFO lots, maker/taker switching, stuck-position timeout — plus market-maker, rebalance, and threshold strategies. |
| [`04-python-ops`](04-python-ops) | Python | Operations-hardened: a **thread-safe nonce manager** (fixes the pending-pool race), EIP-1559 gas, **fill-proof by balance delta**, and an AI decision agent. |
| [`05-production-async`](05-production-async) | Python | The most production-grade: an **async nonce manager with replace-by-fee**, correct native-SOMI sentinel, canonical REST endpoints, a real SIWE library, a full test suite, and a `yield_maker` PostOnly market-making strategy. |
| [`06-multipair-competition`](06-multipair-competition) | Python | The most modern surface: uses **`getAutoPullRequirement`**, correct native gas (5M buy / 6M cancel) and sentinel, the SpotRouter, and a **PnL-weighted multi-pair scanner** that only trades profitable spreads. |
| [`07-stable-maker`](07-stable-maker) | Python | A tight **maker-on-a-stable-pair** strategy: rests PostOnly quotes just off the peg to earn volume + maker rewards at near-zero cost, executed via the official `dreamdex` CLI. |
| [`08-regime-multistrategy`](08-regime-multistrategy) | TS | A Dev Traders bot with **drawdown-adaptive risk regimes** (turns off pure volume when losing) over several genuine modules — a Binance-fed mispricing **arbitrage** (PickOff), a post-only maker, a grid, and honest spread-gated volume. Modern surface. |

## How this maps to the rest of the kit

- The **market-making** strategy distills the inventory-skew MM from #02/#05 and the stable-pair
  maker economics from #07.
- The **grid** strategy is the cleaned-up #03 grid.
- The **momentum** strategy is the classical trend logic from #01/#02.
- The **nonce / 24-7 operations** patterns come from #04 and #05.

Each example keeps its own dependency manifest; treat them as read-only references (they are not
part of the workspace build).
