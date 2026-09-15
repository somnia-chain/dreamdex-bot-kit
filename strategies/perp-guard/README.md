# perp-guard: reduce before the protocol does

Not a trader. It watches margin health and closes part of a position before the
liquidation waterfall reaches it, which is cheaper than being closed at the
maintenance line and charged the liquidation fee.

```bash
npm start -w perp-guard        # DRY_RUN=true by default
```

Env: `PRIVATE_KEY`, `PERP_SYMBOL` (blank watches every market the account holds
a position in), `PERP_GUARD_REDUCE_BELOW`, `PERP_GUARD_REDUCE_PCT`,
`PERP_GUARD_FLATTEN_BELOW`, `PERP_GUARD_POLL_MS`, `DRY_RUN`.

- **Health is equity over the MAINTENANCE requirement**, so `1.0` is the
  liquidation line and `1.5` is half again the cushion the protocol demands. An
  account with no position reads infinity and nothing triggers.
- **Margin is cross.** A position in one market can be closed to cover another,
  which is why leaving `PERP_SYMBOL` blank is the safer default here.
- **A partial close can be too small to send.** On a position only a few
  minimums wide, a 25% reduction lands under the market's `minQuantity`; the
  guard says so rather than looping silently.

`PERP_GUARD_FLATTEN_BELOW` has to sit below `PERP_GUARD_REDUCE_BELOW`, or the
guard would flatten before it ever reduced. It refuses to start otherwise.
