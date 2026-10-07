# perp-maker: two-sided quotes that lean back to flat

Rests a bid and an ask around the mark and skews them with inventory: leaning
long pushes the bid away and pulls the ask in, so the side that unwinds is the
side that fills.

```bash
npm start -w perp-maker        # DRY_RUN=true by default
```

Env: `PRIVATE_KEY`, `PERP_SYMBOL`, `PERP_MM_LEVERAGE`,
`PERP_MM_HALF_SPREAD_BPS`, `PERP_MM_NOTIONAL_USDSO`,
`PERP_MM_MAX_POSITION_USDSO`, `PERP_MM_INVENTORY_SKEW_BPS`,
`PERP_MM_REQUOTE_TRIGGER_BPS`, `PERP_MM_REFRESH_MS`, `DRY_RUN`.

- **It re-quotes on movement, not on a timer.** `PERP_MM_REQUOTE_TRIGGER_BPS`
  is how far the mark has to travel before the quotes are replaced; a smaller
  number means tighter tracking and more gas.
- **The cap is on notional**, so `PERP_MM_MAX_POSITION_USDSO` means the same
  thing on BTC as on DOGE. At the cap the leaning side stops quoting and the
  unwinding side keeps going.
- **Quotes are POST_ONLY**, so a quote that would cross is rejected rather than
  paying the spread it was trying to earn.

Ctrl-C pulls both quotes before exiting.
