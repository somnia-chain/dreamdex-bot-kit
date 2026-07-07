# 03 · Monorepo grid

**Language:** TypeScript (pnpm/turbo monorepo) · **Order path:** direct contract **or** HTTP-prepare

**Status:** Reference — modernize the wallet-funded order path (`placeTakerOrderWithoutVault` → `placeOrder`) before running against current mainnet.

A well-layered monorepo: a shared `packages/sdk` (auth, execution, persistence), a `bots/grid-bot`
with four strategies, and (removed during sanitization) a dashboard app. The standout is the **grid**:

- **`bots/grid-bot/src/strategies/grid.ts`** — FIFO lots (each sell closes the exact lot it bought),
  **maker/taker switching** (rest PostOnly when the counterpart side is absent, take IOC when it's
  present and crossed), a spread gate, a session stop-loss, and a **stuck-lot timeout** that cuts and
  re-anchors so the grid never freezes holding inventory.
- Also `market-maker.ts`, `minute-rebalance.ts`, `threshold.ts` — a clean strategy taxonomy.

**Worth reading:** `bots/grid-bot/src/strategies/grid.ts`, `packages/sdk/src/execution/contract.ts`.

**To modernize:** the wallet-funding path uses `placeTakerOrderWithoutVault` → use `placeOrder`. Its
`expireTimestampNs = 0` handling was only special-cased for testnet; 0 is rejected on **both** networks.

**Learn from it →** the grid design is distilled (and modernized) in
[`../../strategies/grid`](../../strategies/grid).
