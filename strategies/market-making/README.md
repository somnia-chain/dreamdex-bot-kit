# Market Making

Two-sided **PostOnly** quoting with inventory skew. This is the flagship strategy — the
efficient, capital-preserving way to earn volume (and maker rewards) on DreamDEX.

## The idea

The leaderboard ranks by volume, but every round-trip you take costs the spread + fees. If you
generate volume as a **taker**, you bleed. The winning move is to be the **maker**:

1. **Quote a low-risk pair.** Default is `USDC.e:USDso` — a stable/stable pair pinned near
   `1.0000`, so you carry almost no price risk between fills.
2. **Rest on both sides.** Post a bid below mid and an ask above mid with `PostOnly` (which is
   rejected rather than filled if it would cross, so you never accidentally take). When someone
   lifts your quote, *they* pay the spread to *you*, and you earn volume at near-zero — often
   negative — cost.
3. **Skew to manage inventory.** If you end up long the base asset, both quotes lean down so you
   sell more and buy less, pulling inventory back to target. See `MM_INVENTORY_SKEW_BPS`.
4. **Requote only when it matters.** Re-posting an identical quote just burns gas, so we leave
   good quotes in place and only move when the mid drifts past `MM_REQUOTE_TRIGGER_BPS`.

This ties directly into DreamDEX's maker-reward / yield model — see the
[Collateral Yield Algorithm](https://docs.dreamdex.io) docs.

## Run

```bash
npm install                       # from the repo root, once
cp .env.example .env              # set PRIVATE_KEY, keep NETWORK=testnet
npm run dev -w market-making      # DRY_RUN=true by default — logs quotes, sends nothing
```

Set `DRY_RUN=false` in `.env` when you're ready to place real orders. Start small on testnet.

**Python** (same strategy, on the Python core):

```bash
cd python
pip install -r requirements.txt   # installs packages/core-py (web3) in editable mode
cp .env.example .env
python -m bot
```

## Configuration

| Env | Meaning |
| --- | --- |
| `MM_SYMBOL` | Market to quote (default `USDC.e:USDso`). |
| `MM_HALF_SPREAD_BPS` | Distance from mid to each quote. Total spread is 2×. |
| `MM_NOTIONAL_USDSO` | Size per quote, in USDso. |
| `MM_TARGET_INVENTORY_USDSO` | Base inventory (in quote terms) the skew pulls toward. |
| `MM_INVENTORY_SKEW_BPS` | How hard quotes lean per 1× notional of imbalance. |
| `MM_REQUOTE_TRIGGER_BPS` | Mid must move this far before we cancel/replace. |
| `MM_MAX_BOOK_SPREAD_BPS` | Skip quoting when the book is this dislocated. |

## Trade-offs

- **Fills are not guaranteed.** A maker only trades when someone crosses your quote. Tighten
  `MM_HALF_SPREAD_BPS` for more fills (and more inventory risk), widen it for safety.
- **Inventory risk** is the real risk on non-stable pairs. On `SOMI:USDso` or `WETH:USDso` a
  trending market can leave you holding the wrong side — the skew mitigates but doesn't remove it.
  Stick to the stable pair until you've tuned the skew.
- **Not the highest raw volume.** Market making optimizes volume *per dollar risked*, not raw
  throughput — chasing maximum transaction count as a taker bleeds the spread every cycle. To see
  whether your fills actually earn their spread, measure it with [`tools/edge-analytics`](../../tools/edge-analytics)
  (see [`docs/measuring-edge.md`](../../docs/measuring-edge.md)).

## How it maps to the core

Everything DreamDEX-specific lives in [`@dreamdex-bot-kit/core`](../../packages/core): `Pool.place`
quantizes to tick/lot and runs the safe placeOrder lifecycle; `DreamDexWs` handles the feed +
reconnect. This strategy file is just the quoting logic.
