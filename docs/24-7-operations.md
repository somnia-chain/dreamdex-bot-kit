# Running a bot 24/7

A strategy that's correct for one order still has to survive days of unattended running. These
are the operational patterns the top competition bots converged on — most are implemented in
[`packages/core`](../packages/core), and this page explains them so you can tune or reimplement.

## Auth: keep the JWT fresh

The HTTP API uses a JWT (obtained via SIWE) that expires. A long-running bot must refresh it
*before* it lapses, or a request will 401 mid-trade.

- Cache the token and refresh a few minutes early — don't wait for expiry.
- Re-login on a `401`/`403` as a fallback.

Core: `DreamDexRest.ensureAuth()` refreshes 3 minutes before `expiresAt`. If you only place orders
via the direct-contract path (like the example strategies), you don't need the JWT at all — you
sign transactions directly.

## Nonces: the difference between 1 order/5s and many/second

The naive send path — read `getTransactionCount("pending")`, send, **wait for the receipt**,
repeat — is safe but slow. For throughput you manage the nonce locally and stop waiting:

- **One allocator.** Serialize nonce assignment so two concurrent sends can't grab the same
  nonce (which kills one with "nonce too low").
- **Backpressure.** Cap in-flight unconfirmed txs so a stuck one can't let sends pile up
  unbounded.
- **Resync, don't decrement.** On "nonce too low" the chain already consumed the nonce — re-read
  pending from chain rather than rolling back locally (which would reuse it and loop).
- **Replace-by-fee (optional).** If a nonce is stuck past a timeout, resubmit it at higher gas so
  it (and everything queued behind it) can clear.

Core: [`NonceManager`](../packages/core/src/nonce.ts) does allocation, backpressure, and resync.
Wire it into a high-frequency loop for fire-and-forget submission (see the examples in
[`../examples`](../examples), e.g. the ops-hardened bots, for real implementations).

## Fire-and-forget submission

For high-frequency strategies, broadcast and move on — don't `await` the receipt in the hot loop:

```ts
const nonce = await nonces.acquire();
await walletClient.sendTransaction({ to: pool, data, gas, nonce, value: 0n, account, chain });
// don't wait — the next order can go out immediately
```

Reconcile out-of-band: periodically resync the nonce, check your gas balance, and (if you need
fills) read them from chain.

> **Gas floor caveat:** fire-and-forget uses a fixed gas limit. That's fine for ERC-20 pairs, but
> native-SOMI **buys** need ≥ 5,000,000 gas (see [gotchas #4](gotchas.md#4-native-somi-buys-need--5000000-gas)).
> Keep any fixed-gas high-throughput bot on an ERC-20 pair.

## Reading fills from chain (don't trust `/v0/trades`)

The REST trades feed can stall for a long time. For attribution, PnL, or inventory, read the
`OrderFilled` event on-chain and value each fill at the **maker's resting price**:

- Subscribe / poll `getLogs` for `topic0 = TOPIC.OrderFilled` on the pool, in ≤ 1000-block chunks.
- `OrderFilled(takerOrderId, makerOrderId, quantityFilled, takerRemaining, makerRemaining, fillPrice)`
  — the last field, `fillPrice`, is the execution price. Match `takerOrderId`/`makerOrderId`
  against your own order ids (captured from `OrderPlaced`) to know which fills are yours.
- Quote notional (= USDso volume, since quote is USDso) is `fillPrice × quantityFilled`,
  decimal-adjusted.

Core exposes the topics and read helpers in [`contract.ts`](../packages/core/src/contract.ts).

## WebSocket: heartbeat, reconnect, and staleness

- **Heartbeat.** The server drops idle connections after 60s — ping every 30s.
- **Reconnect + replay.** On any disconnect, reconnect with backoff and **re-send your
  subscriptions**. A feed that goes quiet without erroring is the dangerous case: the bot keeps
  quoting on a frozen book.
- **Reconcile against chain.** Periodically compare your WS/REST book against an on-chain
  `getBookLevels` read; if they diverge, trust the chain. A stale quote that no longer crosses is
  the #1 cause of no-fills in a volatile market.

Core: `DreamDexWs` handles heartbeat, backoff reconnect, and subscription replay.

## Gas management

- Keep a **native SOMI reserve** and stop trading before you run out — have the bot halt below a
  minimum gas balance rather than failing mid-loop.
- Use **EIP-1559 fees** where the node supports them so your txs compete under load; fall back to
  legacy `gasPrice` otherwise.
- Add ~20% headroom over the estimate, and remember the native-buy 5M floor.

## Safe rollout

- **`DRY_RUN=true` first.** Every strategy here defaults to it — watch the intended actions before
  sending anything.
- **Canary.** Run a few small live orders before scaling size, and validate they actually filled
  (check the `OrderPlaced`/`OrderFilled` logs), then ramp.
- **Circuit breakers.** Cap session loss, cap tx/hour, and halt on repeated errors. The `grid` and
  `momentum` strategies show stop-loss / guard patterns you can lift.
