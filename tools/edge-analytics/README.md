# Edge analytics

**Does your maker actually have an edge?** This tool answers that from your own
fills. It measures the three numbers that decide whether market-making on
DreamDEX makes money — and it's the one piece of instrumentation the rest of the
kit doesn't ship:

1. **Captured spread** — how far inside the mid you get filled (what you earn).
2. **Adverse selection** — how far the market moves against you *after* you trade
   (what gets taken back).
3. **Transactions per fill** — how many `post`/`cancel`/`reduce` txs you pay for
   per fill you get (whether gas eats the rest).

Market-making is a single inequality (Glosten–Milgrom, 1985): **you profit only
if captured spread > adverse selection.** The strategies in this kit help you
*quote*; this example tells you whether those quotes are being *picked off*. If
adverse selection exceeds the spread, no amount of parameter tuning fixes it —
you're choosing between two ways to lose, and the honest move is to change the
edge, not the knobs.

> Read the companion methodology note: [`../../docs/measuring-edge.md`](../../docs/measuring-edge.md).

## Quick start (zero setup)

```bash
npm install
npm start          # runs on the bundled sample dataset
```

The sample is a deliberately *losing* maker, so you can see what the failure mode
looks like:

```
── DreamDEX edge report ─────────────────────────────────────────
fills: 4  (with mid coverage: 4)
captured spread:  median 5.01 bps   mean 5.01 bps

adverse selection & net edge, marked to mid:
  horizon |   n  | adverse (med) | net (med) | net (mean) | worst-10% share
      1s |    4 |        -0.1 bps |    4.9 bps |    4.9 bps |  50%
     10s |    4 |        -4.2 bps |    0.3 bps |    0.5 bps |  38%
     60s |    4 |       -25.0 bps |  -20.5 bps |  -22.3 bps |  38%

transactions per fill: 14.0  (post 28, cancel 28, reduce 0, fill 4)

VERDICT: NEGATIVE EDGE: median net -20.5 bps at 60s (captured 5.0 bps,
adverse selection -25.0 bps). Adverse selection exceeds the spread — tuning
params won't fix this; change the edge. WARNING: 14 transactions per fill —
gas may eat the edge even if it's positive. Requote less (only on moves >
spread) or use reduceOrder/EIP-7702 batching.
─────────────────────────────────────────────────────────────────
```

The read: this maker earns ~5 bps at the touch and looks fine at 1s, but by 60s
the fills have bled ~25 bps to adverse selection — it's structurally negative,
and it's over-requoting 14× per fill on top.

## Run it on your own bot

The primary input is the kit's **own `csv-logger` output** (the `TradeRow` shape
from [`../02-modular-typescript`](../../examples/02-modular-typescript) — columns
`ts,network,pool,side,action,orderId,price,qty,notional,txHash,note`). If your
bot already logs trades with that logger, you're ready:

```bash
# Preferred: your trade log + a mid-price log from polling the book.
npm run analyze -- --trades data/trades.csv --mid data/mids.csv

# No book log? Approximate the mid from a public trade tape (understates
# adverse selection — treat the numbers as a lower bound).
npm run analyze -- --trades data/trades.csv --mid-from-trades data/tape.csv

# Custom horizons (seconds) and machine-readable output.
npm run analyze -- --trades data/trades.csv --mid data/mids.csv --horizons 1,5,30 --json
```

### Inputs

| File | Format | Where it comes from |
| --- | --- | --- |
| `--trades` | `ts,network,pool,side,action,orderId,price,qty,notional,txHash,note` | the kit `csv-logger` (`action` ∈ `post`/`cancel`/`reduce`/`fill`/…) |
| `--mid` | `ts,mid` | poll `SpotPool.getBookLevels` or the WS book channel; log `(bestBid+bestAsk)/2` |
| `--mid-from-trades` | `ts,price` | a trade tape (e.g. the public trades API) — used as a mid proxy |

`ts` accepts unix seconds, unix milliseconds, or ISO-8601. `side` accepts
`bid`/`buy` (→ you bought) or `ask`/`sell` (→ you sold).

## How to read the report

- **Captured spread (bps):** signed distance from mid at the moment of the fill.
  Positive means you were paid to provide liquidity at the touch.
- **Adverse (med) at horizon h:** median mark-to-mid move *against you* h seconds
  after the fill. This is the adverse-selection cost. It grows with horizon; the
  horizon that matters is roughly your holding/hedging time.
- **Net (med/mean):** captured + adverse. **This is the go/no-go.** Median net < 0
  at your holding horizon ⇒ the maker is structurally unprofitable.
- **Worst-10% share:** how concentrated the damage is. A high share (our own
  live data once showed the worst 10% of fills causing >50% of the drift) means a
  toxicity filter / clip-size cap may help more than widening the spread.
- **Transactions per fill:** `(post+cancel+reduce)/fill`. A healthy maker requotes
  ~1–3× per fill. Double digits means gas is a first-order cost — requote only on
  moves larger than your spread, or amend with `reduceOrder` / batch with
  EIP-7702 (see [`../../advanced/batch-7702`](../../advanced/batch-7702)).

## Limitations (read before you trust a number)

- **Mark-to-mid, not realized.** Net edge is marked to the mid at each horizon,
  not to eventual resolution/close. It's the right measure for *continuous*
  market-making; for a binary/expiry market, also check the realized outcome.
- **`--mid-from-trades` understates adverse selection.** A trade prints at the
  touch, not the mid, so the proxy compresses the drift. Prefer a real book poll.
- **Gas is not subtracted from bps here.** Transactions-per-fill is reported
  alongside so you can price it in yourself; see the methodology note for the
  break-even math at small capital.
- **Fills only.** This measures the trades you got, not the queue position you
  missed. It answers "are my fills toxic?", not "why don't I fill?".

## Layout

```
src/
  types.ts      domain types (Fill, MidTick, Markout, …)
  csv.ts        loaders: kit TradeRow log, mid CSV, trade tape
  markout.ts    the core math (midAt lookup, per-fill markout decomposition)
  report.ts     aggregation, Pareto, transactions-per-fill, verdict
  index.ts      CLI
  markout.test.ts  vitest unit tests for the math + sign conventions
sample/         a self-contained illustrative dataset
```

Pure Node + TypeScript, zero runtime dependencies. `npm test` covers the markout
math and the buy/sell sign conventions.
