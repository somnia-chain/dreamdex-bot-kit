# TWAP (Time-Weighted Average Price)

An **execution algorithm**, not a signal strategy. Give it a target size to buy or sell and it
splits the order into equal slices spread evenly over time — so you build (or unwind) a position
without slamming the book in one shot.

## The idea

Instead of sending one big order that walks the book and pays a bad average price, TWAP sends
`TWAP_SLICES` smaller orders, one every `TWAP_INTERVAL_SEC` seconds. Each slice is an IOC bounded
by `TWAP_MAX_SLIPPAGE_BPS`, so it fills against nearby liquidity but never chases the price past
your limit. Over the schedule your average fill approaches the time-weighted average price.

This is the quant's basic "get into size quietly" tool — useful on its own (accumulate/distribute
a position) and as a building block inside a larger strategy.

## Run

```bash
npm install
cp .env.example .env              # PRIVATE_KEY, NETWORK=testnet
# buy $20 of SOMI over 5 slices, 30s apart:
npm run dev -w twap               # DRY_RUN=true — logs the schedule, sends nothing
```

Set `TWAP_SIDE=sell` to distribute instead of accumulate. It exits when the schedule completes.

## Configuration

| Env | Meaning |
| --- | --- |
| `TWAP_SIDE` | `buy` (accumulate) or `sell` (distribute). |
| `TWAP_TOTAL_USDSO` | Total quote notional to execute across all slices. |
| `TWAP_SLICES` | Number of equal slices. |
| `TWAP_INTERVAL_SEC` | Seconds between slices (total duration ≈ slices × this). |
| `TWAP_MAX_SLIPPAGE_BPS` | Price bound each slice may cross by. |

## Trade-offs

- **TWAP is time-based, not volume-aware.** If the market moves against you mid-schedule, later
  slices execute at worse prices — TWAP trades urgency for lower single-shot impact, it doesn't
  predict direction. (A volume-aware variant, VWAP, sizes slices to traded volume instead.)
- **Slice size vs `minQuantity`.** Very small slices can fall below the market minimum — the bot
  warns and skips rather than stalling. Size `TWAP_TOTAL_USDSO / TWAP_SLICES` above `minQuantity`.
- For exact fill accounting, read `OrderFilled` from chain — see
  [`../../docs/24-7-operations.md`](../../docs/24-7-operations.md). The progress log here is
  best-effort (intended slice size).
