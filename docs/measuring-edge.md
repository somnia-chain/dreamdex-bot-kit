# Measuring edge: adverse selection, spread, and gas

Most market-making bots die quietly. They quote, they fill, the balance drifts
down, and it's never obvious *why* — was it fees, gas, bad parameters, or the
market? This note defines the handful of measurements that make the cause
legible, and the example in
[`tools/edge-analytics`](../tools/edge-analytics) computes them from
your own fills.

## The one inequality

Market-making has a single break-even condition (Glosten & Milgrom, 1985):

> **You profit only if the spread you capture exceeds the adverse selection you
> suffer.**

Adverse selection is the cost of trading with someone better-informed or faster:
your resting quote gets hit *precisely when* the mid is about to move against
you. Everything below is a way to see that inequality in your own data instead of
inferring it from PnL alone.

## Definitions

For a fill of one unit at price `p`, let `sign = +1` if you **bought** (a resting
bid was hit → you're long) and `sign = -1` if you **sold**. Let `mid₀` be the mid
at the instant of the fill and `midₕ` the mid `h` seconds later. All figures are
in basis points of `mid₀`.

- **Captured (half-)spread** = `sign · (mid₀ − p) / mid₀ · 10⁴`
  How far inside the mid you were filled. Positive = you were paid for liquidity.

- **Adverse move at horizon h** = `sign · (midₕ − mid₀) / mid₀ · 10⁴`
  Where the market went while you held. Negative = it moved against you.

- **Net edge at horizon h** = captured + adverse move = `sign · (midₕ − p) / mid₀ · 10⁴`
  The mark-to-mid PnL of the fill. **Median net < 0 at your holding horizon ⇒ the
  core is negative.** No spread/skew/inventory parameter fixes a negative core;
  only a different *edge* does.

Pick the horizon that matches how long you actually carry inventory before
hedging or the quote refreshing. If you hedge in ~10s, the 10s column is your
truth; if you rest quotes for a minute, use 60s.

## Why widening the spread usually doesn't save you

The intuitive fix for getting picked off is "quote wider." But on a toxic venue,
widening lowers your fill rate *and* the fills you still get are the most toxic
ones — adverse selection rises roughly in step with the spread, so net barely
moves. If the **worst-decile share** in the report is high (a few fills causing
most of the damage), a toxicity filter (order-book imbalance, aggressor clip
size) or a clip-size cap typically buys more than a wider spread. If net is
negative across *all* horizons and spreads, the venue's flow is informed and the
honest conclusion is that passive liquidity provision there is a donation.

## The metric people forget: transactions per fill

Captured spread and adverse selection are priced in the asset. **Gas is priced
per transaction, independent of size** — so at small capital it can dominate
everything else. The cheap, brutal diagnostic is:

> **transactions per fill = (post + cancel + reduce) / fill**

A disciplined maker requotes ~1–3× per fill. If you're at 10×–100×, you are
paying gas on a runaway quote loop, and it can exceed your adverse-selection cost
outright — a failure that looks like "toxicity" in the PnL but is actually
self-inflicted. Fixes, cheapest first:

1. **Requote only on moves larger than your spread** (or rate-limit requotes).
2. **Amend instead of cancel+replace** — `reduceOrder(orderId, newQty)` shrinks a
   resting order in one tx instead of two.
3. **Batch** multiple order ops into one transaction with EIP-7702
   ([`advanced/batch-7702`](../advanced/batch-7702)).

## Break-even at small capital

A back-of-envelope test before you commit capital. Let

- `E` = expected net edge per fill (bps of notional), from the report;
- `N` = notional per fill (quote units);
- `g` = gas cost per transaction (quote units);
- `t` = transactions per fill.

Per-fill profit ≈ `E·1e-4·N − t·g`. You need `E·1e-4·N > t·g`, i.e.

> **N > t·g / (E·1e-4)**

If `E` is small and `t·g` is not, the required notional per fill can exceed your
entire bankroll — which is the quantitative statement of "this doesn't work at
this size." Run the numbers with your real `t` and `g` before scaling.

## The five edges (name yours before you build)

Profitable market-making rests on at least one structural edge. If you can't name
one, the measurements above will simply confirm you don't have it:

1. **Rebates / incentives** — being paid to provide liquidity, cushioning AS.
2. **Latency** — cancelling stale quotes before informed flow arrives.
3. **Real alpha** — a signal that shifts your reservation price ahead of takers.
4. **Scale** — amortising per-tx gas across large notional.
5. **Benign flow** — genuinely uninformed counterparties to trade against.

## Workflow

1. Log trades with the kit's `csv-logger` (`post`/`cancel`/`fill` rows; the tool
   also counts `reduce` if you extend the logger's `action` union to emit it).
2. Log mids: poll `SpotPool.getBookLevels` (or the WS book channel) and record
   `(bestBid+bestAsk)/2` with a timestamp, ideally every ≤2s.
3. Run `tools/edge-analytics` over both.
4. Read the verdict. Negative net at your horizon ⇒ stop and change the edge, not
   the parameters. Positive net but high transactions-per-fill ⇒ fix the quote
   loop (reduceOrder / batching) before scaling.

## References

- Glosten, L. & Milgrom, P. (1985), *Bid, Ask and Transaction Prices in a
  Specialist Market with Heterogeneously Informed Traders.*
- Avellaneda, M. & Stoikov, S. (2008), *High-frequency Trading in a Limit Order
  Book* — for the quoting side this measures.
