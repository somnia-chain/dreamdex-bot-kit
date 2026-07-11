# Getting Started

This walks you from an empty wallet to a running bot. It assumes you can read TypeScript or
Python but know nothing about DreamDEX yet. The protocol itself is documented at
**[docs.dreamdex.io](https://docs.dreamdex.io)** — start with its
[Quick Start](https://docs.dreamdex.io) if you want the raw curl/CLI walkthrough.

## 1. Prerequisites

- Node 20+ (for the TypeScript strategies) and/or Python 3.11+ (for the Python ones).
- A funded EVM wallet. **Start on Shannon testnet** (chain `50312`); get test funds at
  [testnet.somnia.network](https://testnet.somnia.network).
- Your private key. For anything past testnet, use an encrypted keystore — see
  [Key handling](#5-key-handling).

## 2. Install

```bash
git clone <this repo> && cd dreamdex-bot-kit
npm install        # installs the workspace: core + all TS strategies
```

## 3. Configure

Copy the root env template, then each strategy has its own knobs:

```bash
cp .env.example .env
# edit .env: set PRIVATE_KEY and keep NETWORK=testnet
```

`PRIVATE_KEY` and `NETWORK` are read from your environment; strategy-specific settings live in
each strategy's `.env.example`.

## 4. Fund the bot

DreamDEX has two funding models (details in [architecture.md](architecture.md)):

- **Wallet funding (default).** `placeOrder` pulls the input straight from your wallet at
  execution time (auto-pull). You just need the tokens in your wallet, plus a one-time ERC-20
  approval to the pool — the strategies handle the approval for you. This is the path all the
  example strategies use.
- **Vault funding (optional).** Pre-deposit into the pool's vault and trade against that balance.
  Only needed for specific market-making setups.

You need the **base** or **quote** token of the market you want to trade, plus native **SOMI**
for gas. The strategies default to `SOMI:USDso` (available on both testnet and mainnet), so on
testnet you mainly need SOMI. On mainnet, a stable/stable pair like `USDC.e:USDso` is a lower-risk
place to start (hold some USDso). Testnet markets are `SOMI:USDso`, `WETH:USDso`, and `WBTC:USDso`.

## 5. Run

Every strategy defaults to **`DRY_RUN=true`** — it logs exactly what it *would* do without
sending a transaction. Watch it for a while, then flip `DRY_RUN=false`.

```bash
npm run dev -w market-making      # or grid / momentum
```

For Python strategies:

```bash
cd strategies/market-making/python
pip install -r requirements.txt
cp .env.example .env
python -m bot
```

## 6. Key handling

- **Never commit a key.** `.env`, `*.key`, and `keystore.json` are git-ignored here — keep it
  that way.
- Prefer an **encrypted keystore** over a raw `PRIVATE_KEY` for real funds (e.g. ethers'
  `Wallet.fromEncryptedJson` / a web3 keystore), so the raw key never sits in an env file.
- **Strongest option: session keys.** Run the bot with an *operator* key that can place/cancel
  orders but **cannot withdraw funds** — so a compromised server can't drain you. See
  [session-keys.md](session-keys.md).
- Use a **dedicated bot wallet** with only the capital you're willing to automate — not your main
  wallet.

## Next

- [architecture.md](architecture.md) — how orders actually get placed, and the choices you have.
- [gotchas.md](gotchas.md) — read this before you go live. It's the list of things that silently
  reject or revert an order.
- [24-7-operations.md](24-7-operations.md) — running a bot continuously: auth refresh, nonces,
  reconnects, throughput.
