# Session keys (split-key trading)

The single biggest risk of running a bot 24/7 is that the key it signs with lives on a server.
If that box is compromised, a raw private key means drained funds. DreamDEX's **operator**
(split-key) model removes that: your bot runs with a **hot key that can place and cancel orders
but can never move funds**.

## The model

Two keys, two roles:

- **Fund key (owner)** — cold, used rarely. Holds the money. Deposits working capital into the
  pool's vault and grants the operator permission. This is the only key that can withdraw.
- **Operator key (the bot)** — hot, on the server. Places/cancels orders **on the owner's behalf**
  via `placeOrderFor` / `cancelOrderFor`. It can't deposit, withdraw, or grant approvals — those
  are owner-scoped — and every fill settles to the **owner's** vault, never the operator's.

Authorization is recorded in the on-chain **OperatorPermissionsRegistry**, per function selector,
and the pool enforces it inside every `placeOrderFor` / `cancelOrderFor`. Revocation is immediate.

## Setup (once, with the fund key)

```bash
# grant a hot key, deposit 50 USDso of working capital on USDC.e:USDso:
PRIVATE_KEY=<fund key> \
OPERATOR_ADDRESS=0x<hot bot key address> \
OP_SYMBOL=USDC.e:USDso OP_DEPOSIT_USDSO=50 \
npx tsx scripts/operator-setup.ts
```

This puts the pool in manual vault mode, deposits the capital into the vault, and grants the
operator the `placeOrderFor` + `cancelOrderFor` selectors. (Deposit `OP_DEPOSIT_BASE` too if your
strategy also sells the base, e.g. a two-sided market maker.)

## Run any strategy in operator mode

Set `OWNER_ADDRESS` and use the **operator** key as `PRIVATE_KEY` — every strategy in this kit then
routes its orders through `placeOrderFor` automatically (no code changes):

```bash
# in the strategy's .env:
PRIVATE_KEY=<operator key>
OWNER_ADDRESS=<fund address>
```

Under the hood, `Pool.place` / `Pool.cancel` detect `ctx.owner` and call the operator entrypoints.
Orders draw from — and settle to — the owner's vault.

## Using the helpers directly

```ts
import { createChainContext, Pool, setManualVaultMode, depositVault, grantOperator } from "@dreamdex-bot-kit/core";

// owner (fund key) — one-time:
const fund = createChainContext(FUND_KEY);
await setManualVaultMode(fund, poolAddress, true);
await depositVault(fund, poolAddress, usdsoAddress, amountRaw);
await grantOperator(fund, poolAddress, operatorAddress); // place + cancel

// operator (bot) — set ctx.owner and just trade:
const op = { ...createChainContext(OPERATOR_KEY), owner: fundAddress };
const pool = await Pool.load(op, "USDC.e:USDso");
await pool.place({ isBid: true, price: 0.9999, qty: 5, orderType: 3 /* PostOnly */ }); // → placeOrderFor
```

## Notes & caveats

- **Grant only what you need.** `operator-setup` grants place + cancel. `reduceOrderFor` is a
  separate selector — grant it only if your bot reduces orders.
- **Per pool.** Each pool is its own vault and its own grant. Set up each market you'll trade.
- **Global grants** (`setOperatorApprovalGlobal`) cover every registered pool, *including ones the
  admin adds later* — convenient, but broader. The per-pool grant used here is the tighter default.
- **Manual vault mode** means the operator draws from the vault, not the wallet — so keep the
  vault funded; top it up from the fund key as it depletes.
- **`getOwnOpenOrders()` is caller-scoped.** In operator mode it returns the *operator's* orders
  (none) — your strategy should track the order ids it placed (the ones here do), or read the
  owner's orders from the owner key.
- Verified live on Somnia mainnet: an operator key placed and cancelled an order for the owner,
  and the order settled to the owner — the operator never held funds.
