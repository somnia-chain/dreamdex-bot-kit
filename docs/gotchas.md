# Gotchas

The things that will silently reject or revert your order. Every one of these was hit by a real
competition bot. Most are guarded for you in
[`packages/core/src/gotchas.ts`](../packages/core/src/gotchas.ts) and `execute.ts` — this page is
so you understand *why*, and so the Python port and your own code get them right too.

Protocol reference for each: [docs.dreamdex.io](https://docs.dreamdex.io).

---

### 1. `placeTakerOrderWithoutVault` is gone

**Symptom:** your direct-contract call reverts / the function doesn't exist.
**Cause:** the June 2026 spot upgrade removed it. The single entry point is now the `payable`
`placeOrder`.
**Fix:** use `placeOrder`. Wallet auto-pull is the default; native input goes in `msg.value`.
Core uses the modern signature everywhere.

### 2. `expireTimestampNs = 0` is rejected — it is NOT "no expiry"

**Symptom:** order rejected / sim returns `success=false` with a valid-looking order.
**Cause:** `0`, past, or current-time expiries are all rejected. There is no "never expires"
sentinel.
**Fix:** pass a **future** nanosecond timestamp: `(Date.now() + lifetimeMs) * 1_000_000`. Core:
`buildExpireNs()` / `assertExpireNs()`.

### 3. `priceRaw = 0` never crosses — it's a literal price, not "market"

**Symptom:** an IOC/FOK "market" order mines but fills nothing.
**Cause:** a price of 0 is a real limit price of zero; it never crosses the book.
**Fix:** price your taker to cross — a buy at/above the best ask, a sell at/below the best bid.
Core: `assertPriceRawNonZero()`, and the strategies add a `crossBps` buffer (see #9).

### 4. Native SOMI buys need ≥ 5,000,000 gas

**Symptom:** a `SOMI:USDso` **buy** reverts with `InsufficientGasForPayout` (selector
`0x782b2567`).
**Cause:** delivering native SOMI to the buyer runs a gas-headroom guard on the payout path.
**Fix:** set the tx gas limit to **≥ 5,000,000** on native-base buys, and **simulate with the
same gas limit you broadcast** (a sim at a higher limit will lie to you). Core: `execute.ts`
raises the floor to `NATIVE_BASE_BUY_GAS` for native buys automatically. If you build a
high-throughput bot with a fixed gas limit, don't point it at a native-base pair for the same reason.

### 5. Native SOMI vault balance uses a sentinel address, not `address(0)`

**Symptom:** vault-balance reads for native SOMI return 0 / wrong values.
**Cause:** SOMI has no ERC-20 contract; the native side is keyed by a sentinel.
**Fix:** use **`0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00`** as the token for native
`getWithdrawableBalance`. Core: exported as `NATIVE_SENTINEL`; `Pool.vaultBase()` uses it.

### 6. `getPoolParams()` returns 7 fields, in a specific order

**Symptom:** ABI decode error, or tick/lot/min swapped.
**Cause:** it returns **7** values (no leading `poolToken`), and the order is
`baseToken, quoteToken, makerFee, takerFee, tickSize, minQuantity, lotSize` — maker fee before
taker fee, and **minQuantity before lotSize**.
**Fix:** decode in that exact order. Core: `readPoolParams()`.

### 7. Respect `tickSize`, `lotSize`, `minQuantity`

**Symptom:** order rejected (`invalid_price`, `invalid_amount`) — commonly the *first* order.
**Cause:** price must be a whole multiple of `tickSize`; quantity a whole multiple of `lotSize`
and ≥ `minQuantity`.
**Fix:** quantize in integer space. Core: `alignToTick()`, `alignToLot()`, plus
`assertQtyAboveMin` / `assertPriceMultipleOfTick`.

### 8. A mined transaction can still be a silent rejection

**Symptom:** tx `status = 1` (success) but nothing traded and no order rests.
**Cause:** `placeOrder` returns `(success, orderId)`; a `false` there does not revert the tx.
**Fix:** two defenses — (a) **simulate first** (`eth_call`); if `success` is false, don't
broadcast; (b) after mining, **confirm an `OrderPlaced` log is present** (empty logs = rejected).
Core does both, and reads the real `orderId` from the receipt, not the simulation.

### 9. Crossing by +1 tick often doesn't actually cross

**Symptom:** a taker priced at exactly the touch (or +1 tick) mines but doesn't fill.
**Cause:** the resting order can move/get pulled between your read and your inclusion (JIT/MEV,
or just a fast tape).
**Fix:** price a few ticks / a handful of bps *through* the touch. The strategies expose a
`crossBps` knob (≈5–8 bps matched what live bots needed).

### 10. `OrderFilled` gained a field — pin the topic, don't hand-roll it

**Symptom:** your fill listener silently stops matching after the upgrade.
**Cause:** `OrderFilled` is now 6 args (added `fillPrice`); its `topic0` changed. Code that
computes the topic from an old signature string no longer matches.
**Fix:** pin `topic0` from the docs. Core: `TOPIC.OrderFilled =
0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399`.

### 11. `/v0/trades` (REST) can stall for a long time

**Symptom:** your fills/PnL view freezes while trading continues.
**Cause:** the REST trade feed can lag or stall for extended periods.
**Fix:** for anything that depends on fills (attribution, volume, inventory), **read `OrderFilled`
from chain**, valuing each fill at the maker's resting price. See
[24-7-operations.md](24-7-operations.md).

### 12. `getBookLevels` returns `[]` on an empty book — it does NOT revert

**Symptom:** you wrapped the read in a broad try/catch expecting a revert, and now real RPC/ABI
errors get silently swallowed as an "empty book".
**Fix:** don't mask errors — `getBookLevels` returns an empty array when a side is empty, so let
genuine failures propagate. Core: `readBookLevels()` reads it directly with no revert-swallowing.

### 13. This kit places orders without a builder code

**On-chain reality:** builder codes are **enabled on mainnet** — all four pools report
`getMaxBuilderFeeBpsTimes1k() = 100000` (a **1% fee cap**). **Testnet** currently reports a cap of
`0`.
**What the kit does:** it trades untagged — `builder = address(0)`, `builderFeeBpsTimes1k = 0` —
which produces valid orders on both networks. Core: `assertBuilderDisabled` enforces that untagged
path.
**To use a builder code:** read the live cap with `getMaxBuilderFeeBpsTimes1k()`, call
`approveBuilder` once, then pass a fee `<= cap` and include it in the `getAutoPullRequirement` call.
Builder support is a planned addition to this kit.

### 14. SIWE Chain ID must match the network

**Symptom:** login fails, or works inconsistently across environments.
**Cause:** the `Chain ID` in the SIWE message must match the network you're signing txs for:
**`5031` mainnet, `50312` testnet**. (A V1 bot that mismatched these "worked" via lax validation
at the time — don't copy that.)
**Fix:** derive it from your network. Core: `DreamDexRest` sets it from `NETWORK`.

### 15. USDso is 18 decimals

**Symptom:** everything mispriced by a factor of 10^12.
**Cause:** assuming USDso is a 6-decimal USDC-style stablecoin. It's **18**.
**Fix:** never hard-code decimals — read them from `GET /v0/markets` / `getPoolParams`. Core's
market table has the correct per-token decimals.

### 16. The REST order book can lag the on-chain book

**Symptom:** you quote/cross against a price that's already gone.
**Fix:** treat REST snapshots as approximate; for anything price-sensitive, read `getBookLevels`
on-chain (the strategies do), and periodically reconcile your WS view against it.
