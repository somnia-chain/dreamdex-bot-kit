# 05 · Production-grade async Python

**Language:** Python (async web3) · **Order path:** HTTP-prepare · **Modern:** yes (no removed calls)

**Status:** Runnable on the current contract surface — install its own deps + config first, and test on **testnet** before pointing it at mainnet.

The most professionally engineered bot: a proper package with typed strategy/risk interfaces, a full
`pytest` suite, YAML config profiles, a preflight, and a custom-error-selector probe.

- **`src/dreamdex_bot/core/signer.py`** — the reference **async nonce manager**: serialized allocation,
  a **backpressure cap**, a stuck-tx reconciler that does **replace-by-fee**, and `resync_from_chain`
  on "nonce too low" (rather than an unsafe local decrement). Its docstring is essentially the 24/7
  gas/nonce playbook.
- **Correct native-SOMI sentinel** (`0x28f34…`) — the only bot in the cohort that gets this right.
- Canonical REST endpoints (`/v0/orderbooks`), a real SIWE library, WS reconnect + REST/chain
  reconciliation, and two clean strategies: `volume_mill` (IOC ping-pong) and `yield_maker` (PostOnly).

**Worth reading:** `src/dreamdex_bot/core/signer.py`, `src/dreamdex_bot/strategies/{volume_mill,yield_maker}.py`.

**Learn from it →** the async nonce/RBF ideas inform [`../../packages/core/src/nonce.ts`](../../packages/core/src/nonce.ts);
`yield_maker` maps to [`../../strategies/market-making`](../../strategies/market-making). (`volume_mill`
is an honest IOC volume strategy kept here as part of the original framework — it crosses the real
book, no self-crossing.)
