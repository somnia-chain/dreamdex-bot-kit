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

---

## Event Contracts (binary markets)

The sixteen above are the spot and perp surface. A binary pool is a different contract with its
own set, and every one of these was hit by a real vault quoting Event Contracts on Shannon. Each
entry links to the issue carrying its reproduction.

### 17. Binary order prices are scaled to the collateral's decimals

**Symptom:** every order reverts and no revert mentions price. With a post-only order the sides
fail differently: `PostOnlyWouldCross()` on `BUY_YES` and `SELL_NO`, `PriceOutOfBounds()` on
`SELL_YES` and `BUY_NO`. With a plain limit order all four give `PriceOutOfBounds()`.
**Cause:** a probability of 0.727 goes on the wire as `727000` against 6-decimal tUSDC and
`727e15` against 18-decimal USDso. Both errors are truthful, since a price that large would cross
the whole book on the bid side and is out of bounds on the ask side, which is why they send you
looking at spreads and post-only semantics instead of at the scale.
**Fix:** derive `priceOne` from the collateral's `decimals()`, never from a literal, and read the
grid rather than assuming it. `getBinaryBookParams(pool)` returns `tickSize`, `lotSize` and
`minQuantity` (`1e3` on testnet, `1e15` on mainnet), and the market row carries
`precision.price = 3`. Once the scale is right the reverts turn honest:
`ERC20InsufficientAllowance` on a buy, `InsufficientPermission` on a sell.
([#26](https://github.com/somnia-chain/dreamdex-bot-kit/issues/26))

### 18. The spot `placeOrder` exists on a binary pool and can never succeed

**Symptom:** the spot `placeOrder(bool isBid, ...)` sent to a binary pool reverts
`UseBinaryPlacement()` (`0x341c6622`). `getAutoPullRequirement` and `somiPaymentPerOrder` revert
with no data at all.
**Cause:** a binary pool keeps the order book's spot entry point and disables it. The two views
are not in the binary implementation, so those calls hit a selector that does not exist, which is
why there is nothing to decode. `binaryPoolWriteAbi` carries only the binary entries; the spot
signature comes from `spotPoolWriteAbi` or `perpPoolWriteAbi`.
**Fix:** `placeBinaryOrder` only, with `kind` 0 `BUY_YES`, 1 `SELL_YES`, 2 `BUY_NO`, 3 `SELL_NO`,
and the price always quoted on the YES side. There is no binary counterpart of
`getAutoPullRequirement`, so size a buy against your balance yourself.
([#27](https://github.com/somnia-chain/dreamdex-bot-kit/issues/27))

### 19. Redemption pulls through the module, not the pool

**Symptom:** `redeem` or `mergeCompleteSet` reverts `InsufficientPermission()` (`0xdeda9030`),
with nothing in the error saying which spender is missing.
**Cause:** buying outcome tokens pulls nothing, because two crossing buys mint a fresh pair, so
no ERC-6909 grant is needed until the one call that turns tokens back into collateral. The puller
then is the markets module, not the pool the orders went to.
**Fix:** `trader.redeem` already handles this: it grants the module as ERC-6909 operator before
the call unless you pass `autoApprove: false`. You need the grant yourself only when you call the
module directly or turn auto-approve off, and then it is
`outcomeToken.setOperator(binaryMarketsModule, true)`, once, at construction rather than at
settlement. By the time it reverts the window has resolved and left the live market list.
([#32](https://github.com/somnia-chain/dreamdex-bot-kit/issues/32))

### 20. `cancelOrder` reverts on a leg that already filled

**Symptom:** cancelling both legs of a two-sided quote reverts on the filled leg and takes the
whole cleanup down with it. The error depends on what now holds that order's slot:
`IncorrectSender(address sender, address expected)` (`0xf5e39c1f`) with `expected` = `0x0` when
the slot is empty or another trader's address when their newer order reuses it, and
`IncorrectOrder()` (`0x8080c2ed`) when your own newer order does.
**Cause:** a filled id no longer names a live order you own, and its slot can already hold a
newer order.
**Fix:** use the pool's batch `cancelOrders(uint128[])`: it returns a `bool[]`, `false` for an id
that is gone, and still cancels the live ones. Or isolate each single cancel, as the kit's
`tryCancel` does: `IncorrectSender` and `IncorrectOrder` mean the order is already gone, while any
other failure, such as `CloseNotCaptured()` (#21) or `InsufficientGasForPayout` (#23), means it is
still resting.
([#33](https://github.com/somnia-chain/dreamdex-bot-kit/issues/33))

### 21. Closing orders are locked from expiry until the close is captured

**Symptom:** after expiry, `cancelOrder`, `cancelOrders`, `cancelExpiredOrders` and
`sweepExpiredAtLevel` revert `CloseNotCaptured()` (`0x8afbce93`) on a closing order, one whose
expiry equals the market's. One closing id reverts a whole batch; orders that expired earlier
still sweep. The selector decodes from markets-sdk 0.29.0 on; older pins carry no entry for it,
which is why the revert can look like nothing at all.
**Cause:** the pool freezes the closing book so no one can edit it after trading ends. The lock
lifts once the closing price is captured or the market is resolved or voided.
**Fix:** `captureClose(0)` is permissionless from expiry (before it, `CaptureTooEarly()`); once it
has run, cancels work again. On a normal resolution the lock lasts a few seconds. If the oracle
never answers, `BinaryMarket.voidExpired()` opens at `expiry + settlementWindow` and is
permissionless; called earlier it reverts `SettlementWindowOpen()`. It sits on the **market**,
not among the module's keeper entries. `settlementWindow()` reads `300` on live markets today, so
read it rather than assuming.
([#40](https://github.com/somnia-chain/dreamdex-bot-kit/issues/40),
[#39](https://github.com/somnia-chain/dreamdex-bot-kit/issues/39))

### 22. BinaryPools are beacon proxies, so the running code can change under you

**Symptom:** you read the pool implementation's source to explain a revert and it does not
explain it. An `implementation()` staticcall appears in the internal trace of every pool call and
looks like an access gate.
**Cause:** a pool address holds 291 bytes of beacon proxy. It staticcalls `implementation()`
(`0x5c60da1b`) on the beacon `0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc` and delegatecalls the
result. Through markets-sdk 0.28.1 the `binaryPoolImpl` constant was
`0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD`, the implementation behind the pre-beacon pools; the
beacon has resolved to `0x48e523c9f22f98548d263f0aD444D732e5202C0E` since it was created. 0.29.0
corrected the constant.
**Fix:** resolve `implementation()` off the beacon before you read any source, and watch the
beacon's `Upgraded` event rather than pinning behaviour to a pool address or a constant. The
beacon is upgradeable, so the code behind a live position can change with no address change, and
an error table generated against an older implementation decodes less than the chain emits.
([#41](https://github.com/somnia-chain/dreamdex-bot-kit/issues/41))

### 23. A cancel from a contract needs 1.5M gas left for the payout

**Symptom:** a contract, such as a vault, calls `cancelOrder` on a live order it owns and the pool
reverts `InsufficientGasForPayout(uint256 gasLeft)` (`0x782b2567`). If the contract swallows the
error, the order keeps resting while the contract believes it is gone.
**Cause:** before sending the refund, the pool requires 1,500,000 gas left, so that a failed send
can still fall back to crediting the pool vault.
**Fix:** forward generously. Measured on one cancel sent straight to the pool: a 1,650,000 gas
limit reverts and 1,700,000 passes. A contract adds its own overhead on top, and in a batch each
payout needs the reserve at the moment it runs.
([#38](https://github.com/somnia-chain/dreamdex-bot-kit/issues/38))
