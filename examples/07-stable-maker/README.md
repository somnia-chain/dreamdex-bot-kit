# 07 · Stable-pair maker

**Language:** Python · **Order path:** official `dreamdex` CLI wrapper

**Status:** Reference — requires the official `dreamdex` Go CLI installed to run.

A tight, well-reasoned **market-making** bot that earns volume + maker rewards efficiently by
being the maker on a low-risk pair.

- **`mm_bot.py`** — the maker economics play. The reasoning: the leaderboard ranks by volume, but
  round-trips cost the spread, so *taking* to generate volume bleeds. So (1) trade the
  **stable/stable `USDC.e:USDso`** pair (≈1.0, near-zero price risk), (2) be the **maker** — rest a
  PostOnly bid at 0.9999 and ask at 1.0001, earning volume + maker rewards at near-zero (often
  negative) cost, (3) re-quote instantly on fill. It's inventory-aware, reconciles quotes to avoid
  wasting gas re-posting still-good orders, and opportunistically takes any order priced through
  the peg.
- It executes by shelling out to the official `dreamdex` Go CLI — a legitimate, upgrade-proof
  approach (the CLI signs/broadcasts, so it's insulated from contract-ABI changes).

**Worth reading:** `mm_bot.py` (the maker thesis and the quote/reconcile loop).

**Learn from it →** the maker thesis lives in [`../../strategies/market-making`](../../strategies/market-making).
