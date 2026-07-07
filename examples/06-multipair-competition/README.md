# 06 · Multi-pair competition bot

**Language:** Python (web3.py + async WS) · **Order path:** direct contract · **Modern:** yes (no removed calls)

**Status:** Runnable on the current contract surface — install its own deps + config first, and test on **testnet** before pointing it at mainnet.

The most modern on-chain surface in the cohort, paired with the most leaderboard-aware strategy design.

- **`bot/executor.py`** — uses **`getAutoPullRequirement`** to read the exact wallet input before placing
  (the only bot to do so); correct native-SOMI **sentinel**, a hardcoded **5,000,000-gas floor** for
  native buys and a **6,000,000** floor for native maker cancels; and the **SpotRouter**
  (`quoteMarketExactIn`) for multi-hop routing.
- **`bot/strategies/competition.py`** — PnL-weighted-volume framing (only trade profitable spreads), a
  scoring **multi-pair market scanner**, and an **activity guard** (idle-relax + periodic activity pulse
  to stay active without over-trading). Includes a small test suite.

**Worth reading:** `bot/executor.py`, `bot/strategies/competition.py`, `bot/market_scanner.py`.

**Learn from it →** its funding/gas handling matches [`../../packages/core/src/execute.ts`](../../packages/core/src/execute.ts);
the "trade profitably and stay active 24/7" framing complements
[`../../strategies/market-making`](../../strategies/market-making).
