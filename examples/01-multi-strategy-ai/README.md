# 01 · Multi-strategy AI

**Language:** JavaScript (Node) + Python · **Order path:** HTTP-prepare (sign & broadcast)

**Status:** Reference — the HTTP-prepare path is insulated from the contract upgrade, but it needs its own deps + an LLM provider to actually decide trades.

An LLM-driven decision bot over a classical strategy ensemble:

- **AI decision bot** (`index.js`, `brain/`) — an LLM makes structured BUY/SELL/HOLD calls with
  confidence + stop/target, fed by a classical strategy ensemble (`strategies/grid.js`,
  `momentum.js`, `meanReversion.js`, `coingeckoSentiment.js`) plus external price feeds.

**Worth reading:** the `strategies/*.js` signal logic, `executor/vault.js` (funding),
`executor/orders.js` (order + receipt parsing).

**To modernize:** it uses the legacy vault-deposit-first flow — prefer wallet auto-pull + `placeOrder`
(see [`../../docs/architecture.md`](../../docs/architecture.md)). `quoteDecimals` defaults to 6;
USDso is **18**. A committed API key was scrubbed during sanitization.

**Learn from it →** ensemble signal design. Clean equivalents live in
[`../../strategies/momentum`](../../strategies/momentum) and [`../../strategies/grid`](../../strategies/grid).
