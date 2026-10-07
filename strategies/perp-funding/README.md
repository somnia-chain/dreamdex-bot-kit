# perp-funding: hold the side funding pays

Funding moves between traders rather than to the protocol, so a position on the
paid side earns the rate for as long as it is held. This bot has no view on
price: it takes the paid side when the rate clears the entry threshold and
closes when it falls through the exit one.

```bash
npm start -w perp-funding        # DRY_RUN=true by default
```

Env: `PRIVATE_KEY`, `PERP_SYMBOL`, `PERP_FUNDING_LEVERAGE`,
`PERP_FUNDING_MIN_APR`, `PERP_FUNDING_EXIT_APR`, `PERP_FUNDING_NOTIONAL_USDSO`,
`PERP_FUNDING_MAX_POSITION_USDSO`, `PERP_FUNDING_POLL_MS`, `DRY_RUN`.

- **The APRs are fractions**: `0.1` is 10%. The exit has to sit below the entry,
  or the bot opens and closes on alternate polls; it refuses to start otherwise.
- **The rate is per calculation window, not per settlement interval.** The kit
  annualises it with the SDK's converter rather than dividing by hand, which is
  the mistake that overstates the figure eightfold on the live markets.
- **Carry is not a hedge.** The position is fully exposed to the mark, and one
  adverse move can cost more than weeks of funding.
  `PERP_FUNDING_MAX_POSITION_USDSO` is what bounds that.

Ctrl-C leaves the position open on purpose: closing it would realise PnL nobody
asked to realise. Use perp-guard, or close it yourself.
