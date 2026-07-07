# Contributing

Thanks for helping improve the DreamDEX Bot Kit. This repo is teaching material for
DreamDEX bot builders (Algo Arena / the Dev Traders Program), so the bar is **accuracy and
clarity** over feature count: a contribution should make it easier for a participant to build a
correct bot, and everything must match the live contract.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/core` | The canonical SDK (TypeScript). The modern, verified contract surface. |
| `packages/core-py` | The Python port of the core SDK. |
| `strategies/` | Clean, standalone strategy implementations built on the core. |
| `tools/` | First-party utilities (e.g. `edge-analytics`). |
| `advanced/` | Advanced patterns (e.g. EIP-7702 batching). |
| `docs/` | Architecture, gotchas, and operations notes. |
| `examples/` | **Anonymized** real competition bots, kept as read-only reference. |

`examples/` is special — see "Adding or editing an example bot" below.

## Dev setup & checks

```bash
npm install
npm run typecheck   # builds core, then typechecks every workspace
```

Before opening a PR:

- **`npm run typecheck` must be clean.**
- If you touch a package/strategy/tool with tests, run them (e.g. `npm test` inside
  `tools/edge-analytics` or `examples/08-regime-multistrategy`).
- For Python changes, keep `packages/core-py` importable and its public API mirrored with the TS core.
- Match the surrounding code: comment density, naming, and the existing idioms. New user-facing code
  is **English only**.

## What belongs here

- **Genuine trading logic** — market-making, grid, momentum, mean-reversion, arbitrage, multi-pair
  scanning, analytics, operational hardening.
- Fixes that keep the kit in sync with the live contract (event topics, selectors, gas, order params).

**Not accepted:** pure volume-generation or wash-trade tooling (self-matching, multi-wallet fake
volume, or anything whose only purpose is to inflate transaction count). Honest strategies that
happen to produce volume by crossing the real book are fine; tooling to fake it is not.

## Adding or editing an example bot

`examples/` holds real bots that teams ran, kept as reference. If you add or edit one:

- **Remove everything personal**: private keys, `.env` files, wallet/rival addresses, developer
  handles, deploy scripts, dashboards, and any non-English comments/logs.
- Keep only the genuine strategy code, plus a `.env.example` / `config.example.json`.
- Add a short `README.md` with an honest **Status** line (is it runnable on the current surface, or a
  reference that needs modernizing before mainnet?).
- Don't claim a feature the code doesn't have (e.g. "ships with a test" ⇒ ship a real, asserting test).

## Pull requests

- Keep PRs focused; describe **what** changed and **why it's correct** (link a contract function,
  event, or doc where relevant).
- Note whether you verified against **testnet**, **mainnet**, or offline only.
- One logical change per PR where practical.

## License & legal

This project is MIT-licensed, © DreamDEX S.A. By contributing, you agree your contributions are
licensed under the same terms. Nothing in this repo is financial advice or a guarantee of results —
see [`DISCLAIMER.md`](DISCLAIMER.md). Never commit secrets or a funded key.
