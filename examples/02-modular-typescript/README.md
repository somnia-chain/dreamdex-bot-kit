# 02 · Modular TypeScript (the architecture reference)

**Language:** TypeScript (ethers v6) · **Order path:** direct contract

**Status:** Reference — modernize the direct-contract order path (`placeTakerOrderWithoutVault` → `placeOrder`) before running against current mainnet.

The cleanest architecture in the cohort, and the template `packages/core` is modeled on. Highlights:

- **`src/utils/gotchas.ts`** — a dedicated guard module: expiry, priceRaw≠0, builder-disabled, lot/min,
  and an "OrderPlaced present?" silent-rejection check, all as typed errors.
- **`src/dex/safe-broadcast.ts`** — the order lifecycle done right: `staticCall` simulate → broadcast →
  assert `OrderPlaced` → **read the real orderId from the receipt, not the simulation** (ids can drift).
- **`src/dex/contracts.ts`** — `getBookLevels` wrapped to return `[]` on an empty-book revert.
- Native-base handling, an inventory-skew market maker, and ~50 operational scripts.

**Worth reading:** `src/utils/gotchas.ts`, `src/dex/safe-broadcast.ts`, `src/strategies/market-maker.ts`.

**To modernize:** the `scripts/ioc-loop*.ts` call the removed `placeTakerOrderWithoutVault` and compute
the **old 5-argument `OrderFilled` topic** — both are fixed in `packages/core` (`placeOrder` + the 6-arg
topic). Note: `getPoolParams` was decoded with min/lot swapped here; the correct order is tick → minQty → lot.

**Learn from it →** `gotchas.ts` and `safe-broadcast.ts` are the direct ancestors of
[`../../packages/core/src/gotchas.ts`](../../packages/core/src/gotchas.ts) and
[`execute.ts`](../../packages/core/src/execute.ts).
