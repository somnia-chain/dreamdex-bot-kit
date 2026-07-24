---
name: dreamdex-bot
description: >-
  Build, run, and debug automated trading bots on DreamDEX — Somnia's on-chain
  central limit order book (CLOB) — using this kit. Use when writing or fixing a
  market-making, grid, momentum, TWAP, mean-reversion, or arbitrage bot, placing
  or cancelling orders on a DreamDEX SpotPool, handling order-placement gotchas,
  wiring session-key/operator trading, or measuring whether fills are toxic.
---

# Building trading bots on DreamDEX

DreamDEX is a fully on-chain central limit order book (CLOB) on Somnia. This kit
(`@dreamdex-bot-kit/core`, plus strategy templates) handles the DreamDEX-specific
mechanics so a bot only expresses its logic. Prefer the kit's `Pool` API over
touching raw ABIs or units — it quantizes to tick/lot and routes through a safe
place/cancel lifecycle.

Read the network basics from the **`somnia`** skill first (chain IDs, native
SOMI, USDso 18 decimals).

## Setup

```bash
npm install
cp .env.example .env         # set PRIVATE_KEY; keep NETWORK=testnet to start
npm run dev -w market-making # runs DRY_RUN by default — logs orders, sends nothing
```

Env vars read by core: `PRIVATE_KEY` (funded key), `NETWORK` (`testnet` |
`mainnet`), optional `RPC_URL`, optional `OWNER_ADDRESS` (session-key mode, below).
Every strategy defaults to `DRY_RUN=true`; flip to `false` only after watching it.

`grid`, `momentum` and `mean-reversion` are signal-driven — they can sit idle for minutes
before acting, which is correct, not broken. They print a throttled status line (every
`STATUS_LOG_MS`, default 30000; `0` disables) with what they see and what they wait for.

## Core API

```ts
import { createChainContext, Pool, ORDER_TYPE } from "@dreamdex-bot-kit/core";

const ctx = createChainContext();                 // reads PRIVATE_KEY + NETWORK
const pool = await Pool.load(ctx, "SOMI:USDso");  // markets: SOMI:USDso, WETH:USDso, WBTC:USDso, USDC.e:USDso

const { bestBid, bestAsk, mid } = await pool.topOfBook();

// PostOnly maker quote (never crosses; rejected if it would take):
await pool.place({ isBid: true, price: mid! * 0.999, qty: 1, orderType: ORDER_TYPE.PostOnly });

// IOC taker that actually crosses (price THROUGH the touch, see gotchas):
await pool.place({ isBid: true, price: bestAsk! * 1.0005, qty: 1, orderType: ORDER_TYPE.ImmediateOrCancel });

await pool.cancel(orderId);
const invBase = await pool.walletBase();  // live inventory (see the auto-pull gotcha)
```

`ORDER_TYPE`: `Normal` = 0 (GTC, rests), `FillOrKill` = 1, `ImmediateOrCancel` = 2
(taker default), `PostOnly` = 3 (maker-only). Python mirror: `from dreamdex_core
import Pool, OrderType` — same shape, snake_case.

## Gotchas (these silently reject or revert — get them right)

1. **`placeOrder` is the only entry point.** The old `placeTakerOrderWithoutVault`
   was removed in the June 2026 spot upgrade. `placeOrder` is `payable`; wallet
   auto-pull is the default; native input goes in `msg.value`.
2. **`expireTimestampNs` must be a FUTURE nanosecond timestamp.** `0`, past, or
   now are all rejected — there is no "never expires" sentinel. Use
   `(Date.now() + lifetimeMs) * 1_000_000`.
3. **`price = 0` never crosses** — it's a literal limit price of zero, not
   "market". Price takers a few bps *through* the touch (buy ≥ ask, sell ≤ bid);
   even +1 tick often fails to cross on a fast tape.
4. **Native SOMI buys need ≥ 5,000,000 gas** (payout gas-headroom guard); native
   cancels need a high limit too. **Simulate at the same gas limit you broadcast.**
5. **Native SOMI is a sentinel**, not `address(0)`:
   `0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00`.
6. **A mined tx can be a silent rejection.** `placeOrder` returns `(success,
   orderId)`; `success=false` does NOT revert. Simulate first (`eth_call`), and
   after mining confirm an `OrderPlaced` log exists; read the real `orderId` from
   the receipt, not the simulation.
7. **`getPoolParams()` returns 7 fields** in order: `baseToken, quoteToken,
   makerFee, takerFee, tickSize, minQuantity, lotSize` (minQuantity before
   lotSize). Quantize price to `tickSize`, qty to `lotSize`, qty ≥ `minQuantity`.
8. **Pin the `OrderFilled` topic0** — it gained `fillPrice` (now 6 args) in the
   June 2026 upgrade, so a hand-rolled signature hash won't match. Use
   `0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399`.
9. **`getBookLevels` returns `[]` on an empty book — it does NOT revert.** Don't
   wrap it in a broad try/catch that would mask real RPC/ABI errors as "empty".
10. **Inventory settles to the WALLET.** In the default auto-pull/auto-deliver
    mode, fills land in your wallet and the vault reads ~0 — read inventory with
    `pool.walletBase()` (ERC-20 `balanceOf`, or native balance for SOMI), not the
    vault, unless you explicitly ran `setManualVaultMode(true)`.
11. **USDso is 18 decimals.** Read decimals; never assume 6.
12. **REST (`/v0/trades`, order book) can lag or stall.** For fills/PnL/inventory,
    read `OrderFilled` on-chain; treat REST snapshots as approximate.
13. **Builder codes are enabled on mainnet (1% cap), 0 on testnet.** This kit
    trades **untagged** (`builder = address(0)`), which is valid on both.

Most of these are guarded for you in `packages/core/src/gotchas.ts` +
`execute.ts`. Full prose: `docs/gotchas.md`.

## Session keys (operator / split-key)

Trade from a hot **operator** key that can place/cancel but **never withdraw
funds** — the owner key stays cold. Set `OWNER_ADDRESS` and `createChainContext`
uses the operator to call `placeOrderFor` / `cancelOrderFor` on the owner's
behalf. Grant per-selector permissions via the OperatorPermissionsRegistry;
`scripts/operator-setup.ts` wires it end-to-end. See `docs/session-keys.md`.

## Strategy templates

Ready-to-adapt strategies on top of core (in `strategies/`): **market-making**
(PostOnly two-sided with inventory skew; TS + Python), **grid**, **momentum**,
**twap**, **mean-reversion**, **multi-strategy-ai** (modular ensemble + optional
LLM). Each has its own README and env knobs (e.g.
`MM_SYMBOL`, `MM_HALF_SPREAD_BPS`, `MM_NOTIONAL_USDSO`, `MM_INVENTORY_SKEW_BPS`).
Advanced: `advanced/batch-7702` (EIP-7702 transaction batching).

## Does the bot actually have an edge?

Volume alone isn't profit — a maker only wins if captured spread > adverse
selection. Run `tools/edge-analytics` over your own fills to measure captured
spread vs. adverse-selection drift vs. gas (the Glosten–Milgrom inequality) and
get a go/no-go verdict. Methodology: `docs/measuring-edge.md`.

## Operating a bot 24/7

Serialize sends through one nonce (native single-key, or the core NonceManager
for pipelining), keep a SOMI gas buffer, use a drawdown/gas risk stop, and add a
watchdog that restarts on idle. See `docs/24-7-operations.md`.

> Educational tooling, not financial advice — see `DISCLAIMER.md`. Test on
> testnet with small size before mainnet.
