# 04 · Python, operations-hardened

**Language:** Python (web3.py) · **Order path:** HTTP-prepare + direct contract

**Status:** Reference — modernize the direct-contract paths (`placeTakerOrderWithoutVault` → `placeOrder`) before running against current mainnet.

Deeply battle-tested. The lasting value is its transaction-lifecycle engineering:

- **`backend/trading/wallet.py`** — a **thread-safe local nonce manager** (`reserve_nonce` / `reset_nonce`)
  that fixes the `getTransactionCount("pending")` race which silently drops the second tx in an
  approve→deposit→order chain, plus **nonce-too-low auto-recovery** and EIP-1559 gas fields.
- **`backend/trading/dreamdex.py`** — eth_call simulation before broadcast; **fill-proof by balance
  delta** across *both* the vault and the wallet (native pools deliver to the EOA); and an approval
  **sanity-cap** that detects an already-scaled amount and refuses to over-approve.
- Empirically tuned crossing buffer (`bestAsk + 5 ticks`) — a +1-tick cross often didn't fill.

**Worth reading:** `backend/trading/wallet.py`, `backend/trading/dreamdex.py`.

**To modernize:** the direct-contract paths call `placeTakerOrderWithoutVault` → use `placeOrder`.
Ensure native-SOMI **buys** get ≥ 5,000,000 gas.

**Learn from it →** the nonce and 24/7 patterns are in
[`../../packages/core/src/nonce.ts`](../../packages/core/src/nonce.ts) and
[`../../docs/24-7-operations.md`](../../docs/24-7-operations.md).
