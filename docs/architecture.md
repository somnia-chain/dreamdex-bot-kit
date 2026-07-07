# Architecture: how an order gets placed

There is more than one way to submit an order to DreamDEX. The competition bots used all of them.
This page explains the choices so you can pick deliberately. Full protocol reference:
[docs.dreamdex.io → Developers](https://docs.dreamdex.io).

## Three ways to place an order

| Path | You call… | Signs/broadcasts | Good for |
| --- | --- | --- | --- |
| **Direct contract** | `placeOrder(...)` on the SpotPool, via viem/ethers/web3 | You | Lowest latency, full control. What `packages/core` uses. |
| **HTTP-prepare** | `POST /v0/markets/{sym}/orders` → get an *unsigned* tx → sign & broadcast | You | Server builds current calldata for you (naturally survives contract upgrades). |
| **Official CLI** | shell out to the `dreamdex` Go CLI | The CLI | Quickest to prototype; ABI-break-proof. |

`packages/core` uses the **direct-contract** path with the modern ABI, because it's the most
transparent for teaching and the lowest latency for high-frequency strategies. If you'd rather
have the server build the transaction, the `DreamDexRest.prepareOrder()` helper in
[`packages/core/src/rest.ts`](../packages/core/src/rest.ts) returns the unsigned tx for you to
sign.

## The contract entry point (post-June-2026 upgrade)

> **This is the single most important thing to get right.** The June 2026 upgrade removed
> `placeTakerOrderWithoutVault`. Every V1 bot in [`examples/`](../examples) that calls the
> contract directly uses that removed function — if you copy one, this is the line to change.

There is now one entry point, and it's `payable`:

```solidity
function placeOrder(
    bool isBid, uint64 userData, uint256 price, uint256 quantity,
    uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption,
    address builder, uint96 builderFeeBpsTimes1k
) external payable returns (bool success, uint128 orderId);
```

Order types (`orderType`): `0` GTC / `1` Fill-or-Kill / `2` IOC / `3` PostOnly. Takers use IOC or
FOK; makers use PostOnly (or GTC). See the [Order Types](https://docs.dreamdex.io) docs.

## Funding: wallet (auto-pull) vs vault

By default `placeOrder` **auto-pulls** the input from your wallet and **auto-delivers** proceeds
back to it — no separate deposit/withdraw step.

- **What it pulls.** Call `getAutoPullRequirement(owner, isBid, price, quantity, builderFee)` to
  learn the exact `inputToken` and `requiredAmount` before you place. `packages/core`'s
  `execute.ts` does this for you: if the input token is an ERC-20 it ensures an allowance to the
  pool; if it's native SOMI it sends `msg.value`.
- **Native vs ERC-20 input.** On `SOMI:USDso`, selling SOMI means the input is native → it rides
  in `msg.value`. Buying SOMI means the input is USDso (ERC-20) → allowance. Everything else is
  ERC-20 both ways.
- **Vault (manual) mode.** Market makers who want to keep a working balance in the pool can
  `setManualVaultMode(true)` and use `deposit`/`withdraw`. Optional; the strategies here don't
  need it.

Details: [docs.dreamdex.io → Functions → Auto-pull and auto-deliver](https://docs.dreamdex.io).

## Reading state: REST vs WebSocket vs chain

- **WebSocket** (`wss://.../v0/ws/public`) for live order book and trade updates — subscribe once,
  react to pushes. `packages/core`'s `DreamDexWs` handles heartbeat + reconnect.
- **REST** for one-off snapshots and preparing transactions.
- **On-chain reads** (`getBookLevels`, `getWithdrawableBalance`, `getOwnOpenOrders`) when you want
  the canonical state with no intermediary. The strategies read the book on-chain for correctness.
- **Fills: read from chain.** The REST `/v0/trades` feed can lag or stall. For anything that
  depends on knowing your fills (PnL, attribution, inventory), subscribe to the `OrderFilled`
  event on-chain instead. See [24-7-operations.md](24-7-operations.md).

## How this repo is layered

```
packages/core        the DreamDEX plumbing — import it, don't reinvent it
  config/            networks, market addresses, the native SOMI sentinel
  gotchas.ts         pre-flight guards (the things that silently reject)
  quant.ts           tick/lot/decimal math in integer space
  contract.ts        modern ABI + event topics + read helpers
  execute.ts         the safe placeOrder lifecycle (guard→fund→sim→send→verify)
  pool.ts            ergonomic Pool handle used by the strategies
  nonce.ts           local nonce manager for high-throughput signing
  rest.ts / ws.ts    HTTP (SIWE + prepare) and WebSocket clients
strategies/*         thin: just the signal + sizing logic on top of core
```

Strategies stay small because everything DreamDEX-specific is in the core.
