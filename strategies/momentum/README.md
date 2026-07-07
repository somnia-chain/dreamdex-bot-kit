# Momentum

A directional, trend-following **taker**. The opposite temperament to the maker and grid
strategies: instead of providing liquidity and waiting, it detects a real move and takes it.

## The idea

Each tick samples the mid price into a rolling window. From that window it measures **momentum**
— the recent-half average versus the older-half average. When momentum is strongly positive *and*
price is breaking the window high, it enters long by crossing the ask with an IOC order. It holds
one position and exits when:

- momentum fades back below `MOM_EXIT_MOMENTUM`, or
- take-profit (`MOM_TAKE_PROFIT_PCT`) is hit, or
- stop-loss (`MOM_STOP_LOSS_PCT`) is hit.

This is a long-only reference implementation (spot, so no shorting) — it's flat or long.

## Run

```bash
npm install
cp .env.example .env              # PRIVATE_KEY, NETWORK=testnet
npm run dev -w momentum           # DRY_RUN=true — logs signals, sends nothing
```

Momentum works best on a pair that actually moves — `WETH:USDso` or `SOMI:USDso`, not a stable
pair. On a stable pair it will (correctly) almost never trigger.

## Configuration

| Env | Meaning |
| --- | --- |
| `MOM_WINDOW_SIZE` | How many mid samples define the trend window. |
| `MOM_ENTRY_MOMENTUM` | Momentum threshold to enter (0.008 = 0.8%). |
| `MOM_TAKE_PROFIT_PCT` / `MOM_STOP_LOSS_PCT` | Exit bands on the open position. |
| `MOM_CROSS_BPS` | Buffer past the touch so the IOC crosses and fills. |
| `MOM_INTERVAL_MS` | Sample cadence and poll interval. |

## Trade-offs

- **Pays the spread twice.** As a taker you cross to enter and to exit, so your edge has to beat
  round-trip cost. Don't run this on tight-margin pairs with a large `MOM_WINDOW_SIZE` that lags.
- **Whipsaw risk.** Choppy, non-trending markets generate false breakouts. The stop-loss caps
  each one; widening `MOM_ENTRY_MOMENTUM` reduces how often you get chopped.
- **Crossing buffer matters.** On a fast tape, `bestAsk + 1 tick` may not actually cross (the ask
  gets pulled). `MOM_CROSS_BPS` gives the IOC room to fill — see the crossing note in
  [`../../docs/gotchas.md`](../../docs/gotchas.md).
