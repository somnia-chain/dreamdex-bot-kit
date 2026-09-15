# perp-starter: one leveraged position, bracketed

The smallest complete perp bot. It opens one position, arms a take-profit and a
stop-loss as a **linked pair**, and watches until a leg fires.

```bash
npm start -w perp-starter        # DRY_RUN=true by default
```

Env: `PRIVATE_KEY`, `PERP_SYMBOL` (`BTC-PERP`), `PERP_SIDE` (`long`/`short`),
`PERP_LEVERAGE`, `PERP_NOTIONAL_USDSO`, `PERP_TAKE_PROFIT_PCT`,
`PERP_STOP_LOSS_PCT`, `PERP_TICK_MS`, `DRY_RUN`.

Three things are worth knowing before going live:

- **`PERP_NOTIONAL_USDSO` is position value, not margin.** At 2x, a notional of
  50 needs about 25 in the MarginBank.
- **A bracket costs SOMI, not just collateral.** Each pending stop locks 0.15
  SOMI on the live markets, so a pair holds 0.30 until it is cancelled or fires.
  An account funded only with USDso cannot arm one.
- **Both legs cover the whole position.** They are armed with the
  `quantity: 0` sentinel, so a position that grows later is still fully covered.

Stops left armed after the bot exits would fire against a position nobody is
watching, so Ctrl-C cancels them and reclaims the SOMI. Set
`PERP_FLATTEN_ON_EXIT=true` to close the position on the way out as well.
