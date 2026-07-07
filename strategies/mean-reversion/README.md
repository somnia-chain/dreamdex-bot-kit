# Mean Reversion

A contrarian **taker** — the opposite thesis to [momentum](../momentum). Momentum buys strength;
mean-reversion buys **weakness** and bets on a snap back to the mean.

## The idea

Each tick samples the mid into a rolling window and computes **RSI** and **Bollinger Bands**. It
enters long only when price is statistically stretched to the downside:

- **RSI ≤ oversold** (`MR_RSI_OVERSOLD`, default 30), **and**
- price is at or below the **lower Bollinger band**.

It then exits when price reverts — RSI recovers to `MR_RSI_EXIT` (the mean) — or a take-profit /
stop-loss fires. Long-only (spot), so it's flat or long.

## Run

```bash
npm install
cp .env.example .env              # PRIVATE_KEY, NETWORK=testnet
npm run dev -w mean-reversion     # DRY_RUN=true — logs signals, sends nothing
```

Use a pair that oscillates (`WETH:USDso`, `SOMI:USDso`), not a stable pair — on a peg it will
(correctly) almost never trigger.

## Configuration

| Env | Meaning |
| --- | --- |
| `MR_RSI_OVERSOLD` | RSI threshold to consider entering (lower = more selective). |
| `MR_RSI_EXIT` | RSI level treated as "reverted to mean" for the exit. |
| `MR_BB_PERIOD` / `MR_BB_MULT` | Bollinger window and standard-deviation multiplier. |
| `MR_TAKE_PROFIT_PCT` / `MR_STOP_LOSS_PCT` | Exit bands on the open position. |
| `MR_CROSS_BPS` | Buffer past the touch so the IOC crosses and fills. |

## Trade-offs

- **"Catching a falling knife."** Mean-reversion's failure mode is a genuine trend — you keep
  buying dips that keep dipping. The **stop-loss is the load-bearing risk control** here; don't
  disable it, and don't widen `MR_RSI_OVERSOLD` so far that you enter on any wobble.
- **Pays the spread twice** (taker in and out) — the reversion has to beat round-trip cost.
- Requires a mean-reverting regime; it deliberately does nothing in a strong trend (where
  [momentum](../momentum) is the right tool instead).
