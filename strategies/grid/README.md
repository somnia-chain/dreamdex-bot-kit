# Grid

Buy dips, sell rips around a moving anchor, using **FIFO lots** and **maker/taker switching**.

## The idea

A grid places orders at regular price steps around an anchor:

- **Buy** one step below the anchor. Each buy opens a **lot** at its fill price.
- **Sell** one step above the *oldest* lot's entry. Sells close lots first-in-first-out, so
  every position exits above where it opened.

The step (`GRID_STEP_BPS`) is your per-round-trip gross margin. On a rangebound market the grid
keeps cycling capital, banking the step each time. It's a good fit for a pair that oscillates
rather than trends.

**Maker/taker switching:** when the side you need to trade against is present in the book, the
grid takes it with an IOC order priced to cross. When the book is one-sided (no counterpart), it
rests a `PostOnly` order at the trigger and waits to be lifted — so it still participates on a
thin book instead of doing nothing.

## Guards

Grids fail when the market trends and inventory piles up on one side. Three brakes:

- **Spread gate** (`GRID_MAX_SPREAD_BPS`) — sit out a dislocated book.
- **Session stop-loss** (`GRID_MAX_SESSION_LOSS_USDSO`) — flip to offload-only (stop buying) once
  realized PnL drops too far.
- **Stuck-lot timeout** (`GRID_STUCK_TIMEOUT_MS`) — if a lot can't reach its sell trigger for too
  long, cut it at the best bid and re-anchor to the current mid, so the grid doesn't freeze.

## Run

```bash
npm install
cp .env.example .env              # PRIVATE_KEY, NETWORK=testnet
npm run dev -w grid               # DRY_RUN=true — logs decisions, sends nothing
```

## Configuration

| Env | Meaning |
| --- | --- |
| `GRID_SYMBOL` | Market (default `SOMI:USDso`). |
| `GRID_STEP_BPS` | Grid step / gross margin per round trip. |
| `GRID_LOT_USDSO` | Size of each lot, in USDso. |
| `GRID_MAX_INVENTORY_USDSO` | Stop opening new longs past this inventory. |
| `GRID_MAX_SESSION_LOSS_USDSO` | Offload-only once session PnL drops below −this. |
| `GRID_STUCK_TIMEOUT_MS` | Cut + re-anchor a lot stuck this long (0 disables). |

## Trade-offs

- **Directional risk.** A grid is implicitly short volatility and long the base — a sustained
  down-trend accumulates losing lots. The stop-loss and stuck-timeout limit the damage; sizing
  (`GRID_LOT_USDSO`, `GRID_MAX_INVENTORY_USDSO`) limits it more.
- **Wider step = safer, fewer fills.** Tighten `GRID_STEP_BPS` for more turnover and more
  inventory churn; widen it to only trade meaningful moves.
- Uses on-chain reads for inventory/PnL bookkeeping; for a production grid, reconcile lots
  against real fills (`OrderFilled` on-chain) periodically — see
  [`../../docs/24-7-operations.md`](../../docs/24-7-operations.md).
