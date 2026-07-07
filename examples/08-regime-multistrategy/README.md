# 08 · Regime-adaptive multi-strategy

**Language:** TypeScript (ethers v6) · **Order path:** HTTP-prepare + on-chain fill listening

**Status:** Reference — modern contract surface (correct 6-arg `OrderFilled` topic, HTTP-prepare);
install its own deps + config to run.

A Dev Traders Program bot with several genuine strategy modules and — its standout — **drawdown-
adaptive risk regimes**.

- **`src/regime.ts`** — the highlight. A regime state machine that scales risk to capital: `healthy`
  runs all modules; `caution` disables pure volume (it burns capital); `defensive` keeps only the
  earn/maker module. Hysteresis stops it flip-flopping at the boundary. Ships with an
  assertion-based test — `npm test` (`src/regime.test.ts`).
- **`src/strategy.ts`** — modules that only *propose* orders, merged by the orchestrator:
  - **PickOff** — a mini-**arbitrage**: compares the DreamDEX book against an external fair value
    (a Binance feed) and takes the mispricing. Genuine alpha.
  - **HarvestMaker** (growth) — post-only maker quotes at the touch.
  - **GridMaker** — a post-only ladder.
  - **VolumeBooster** — spread-gated IOC round-trips; honest volume (crosses the real book, ~1.1 bps
    all-in) and it explicitly **avoids self-matching** (never runs the taker churn on a pair where
    it also makes).
- **`src/bot.ts`** — single-nonce execution queue, taker pacing, inventory management, a watchdog,
  and flatten-and-stop. `src/risk.ts` adds a wallet-level drawdown stop + gas floor + order veto.

**Worth reading:** `src/regime.ts` (adaptive risk), `src/strategy.ts` (the PickOff arb + the module
interface), `src/exchange.ts` (SIWE → JWT, unsigned-tx signing, on-chain `OrderFilled` listening).

> ⚠️ **On the volume/reward counter:** the live log's running volume is an *optimistic* estimate — it
> counts each taker at placement assuming a full fill (an IOC can partial). The authoritative number
> is the on-chain `OrderFilled` stream. Reconciling the two needs the REST-id ↔ on-chain-`OrderId`
> mapping (a launch-day VERIFY, marked in `src/exchange.ts`). Don't report the log figure as your
> competition volume — read it from chain.

**Run**

```bash
npm install
cp config.example.json config.json   # tune pairs / clips / modules
cp .env.example .env                  # add your funded dev-wallet key + RPC
npm run dry                           # simulation, no real orders
# npm start                           # live (reads config.json + .env)
```

**Learn from it →** the regime-adaptive risk idea complements the guards in
[`../../docs/24-7-operations.md`](../../docs/24-7-operations.md); the maker module maps to
[`../../strategies/market-making`](../../strategies/market-making).
