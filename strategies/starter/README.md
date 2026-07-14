# starter — the simplest possible bot

The zero-to-running template. A tiny two-sided maker where **you edit one
function** (`decide()` in [`src/strategy.ts`](src/strategy.ts)) and the harness
handles everything else: connecting, placing/cancelling, dry-run, and shutdown.

Start here if you're new. When you outgrow it, the other strategies
([market-making](../market-making), [grid](../grid), [momentum](../momentum),
[mean-reversion](../mean-reversion), [twap](../twap)) show the same ideas done
properly.

## Run it

From the repo root, the fastest path is:

```bash
npm run quickstart      # writes a dry-run .env and points here
npm run dev -w starter
```

Or manually:

```bash
cp strategies/starter/.env.example strategies/starter/.env   # set PRIVATE_KEY, keep NETWORK=testnet
npm run dev -w starter
```

It defaults to **`DRY_RUN=true`** — it logs the orders it *would* place without
sending anything. Watch it, then set `DRY_RUN=false` in `.env` to go live on
testnet.

## Edit your strategy

Open [`src/strategy.ts`](src/strategy.ts) and change `decide()`. It receives a
market snapshot (best bid/ask, mid, your base inventory) and returns the orders
you want resting this tick. That's the whole surface — everything else is done
for you.

## Knobs (`.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `SYMBOL` | `SOMI:USDso` | market to trade |
| `STARTER_SPREAD_BPS` | `10` | total quoted spread (split around mid) |
| `STARTER_SIZE_USDSO` | `20` | order size per side, in USDso notional |
| `STARTER_TICK_MS` | `5000` | how often it re-evaluates |
| `DRY_RUN` | `true` | log only; `false` to send transactions |

> Educational template, not financial advice — see [`../../DISCLAIMER.md`](../../DISCLAIMER.md).
> The harness requotes every tick (simple but gas-hungry); use `market-making`
> for gas-efficient requoting. If a live order errors on size, raise
> `STARTER_SIZE_USDSO` above the market's `minQty`.
