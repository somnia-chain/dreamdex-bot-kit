# DreamDEX Bot Kit

Build automated trading bots on [DreamDEX](https://docs.dreamdex.io) — the on-chain
central-limit order book (CLOB) on [Somnia](https://somnia.network). This kit gives you a
shared client library, five runnable strategies, operations docs for running a bot
24/7, and the sanitized source of the top bots from the first DreamDEX alpha trading
competition.

> **For competent TS / Python devs, zero prior DreamDEX knowledge required.** Everything on
> the DreamDEX protocol itself is documented at **[docs.dreamdex.io](https://docs.dreamdex.io)** —
> this repo does not rewrite the docs, it links to them and shows you working code.

---

## What's inside

| Path | What it is |
| --- | --- |
| [`packages/core`](packages/core) | Shared client — auth, REST, WebSocket, order execution, gotcha guards, nonce manager. TypeScript **and** Python. Every strategy imports it. |
| [`strategies/`](strategies) | Five runnable strategies: [market-making](strategies/market-making), [grid](strategies/grid), [momentum](strategies/momentum), [mean-reversion](strategies/mean-reversion), and [twap](strategies/twap) (execution algo). Each is clone → configure → run, with its own README explaining the trade-offs. |
| [`docs/`](docs) | The bot-specific knowledge the protocol docs don't cover: [getting started](docs/getting-started.md), [architecture](docs/architecture.md), [gotchas](docs/gotchas.md), [running 24/7](docs/24-7-operations.md), [session keys](docs/session-keys.md) (run a bot with a hot key that can't withdraw funds). |
| [`advanced/batch-7702`](advanced/batch-7702) | A **technique demo** (not a trading strategy): how to use EIP-7702 to batch multiple actions into a single transaction. |
| [`tools/edge-analytics`](tools/edge-analytics) | An **analysis tool** (not a bot): measures whether a maker actually has an edge — captured spread vs adverse selection vs transactions-per-fill — from your own fills. Methodology in [docs/measuring-edge.md](docs/measuring-edge.md). |
| [`examples/`](examples) | The real competition bots, sanitized to core code. Different architectures, languages, and tricks — read them to see how people actually did it. |

## The one thing to know before you start

DreamDEX upgraded its spot contracts (June 2026). If you are reading older bot
code (including most of `examples/`), it will call **`placeTakerOrderWithoutVault`** — that
function is **removed**. There is now a single entry point:

```solidity
function placeOrder(
    bool isBid, uint64 userData, uint256 price, uint256 quantity,
    uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption,
    address builder, uint96 builderFeeBpsTimes1k
) external payable returns (bool success, uint128 orderId);
```

`placeOrder` is now `payable` and **pulls funds from your wallet automatically** (auto-pull) —
no separate deposit step for the common case. Everything in `packages/core` and `strategies/`
uses this modern signature. See [docs/architecture.md](docs/architecture.md) for the funding
model and [docs/gotchas.md](docs/gotchas.md) for the full list of things that will bite you.

## Quick start

```bash
git clone <this repo> && cd dreamdex-bot-kit
npm install                       # installs the workspace: core + all TS strategies

cp .env.example .env              # add your PRIVATE_KEY, keep NETWORK=testnet
```

**Verify your setup first** — this read-only check prints your wallet, balances, and the live
order book for every market. No transactions, no risk:

```bash
npx tsx scripts/doctor.ts
```

Then run a bot. Every strategy defaults to **`DRY_RUN=true`** — it logs exactly what it *would*
do without sending anything. Watch it, then set `DRY_RUN=false` in `.env` to go live:

```bash
npm run dev -w market-making      # or: grid · momentum · mean-reversion · twap
```

**Python** (same strategies, on the Python core):

```bash
cd strategies/market-making/python
pip install -r requirements.txt   # installs packages/core-py (web3)
cp .env.example .env
python -m bot
```

Start on **Shannon testnet** (`NETWORK=testnet`, chain `50312`) with small size before you touch
mainnet (`5031`). Get testnet funds at [testnet.somnia.network](https://testnet.somnia.network).
New to all this? Read [docs/getting-started.md](docs/getting-started.md) end to end.

### Helper scripts

Small read-only / cleanup utilities in [`scripts/`](scripts) (run with `npx tsx scripts/<name>.ts`):
`doctor.ts` (setup + balance check), `operator-setup.ts` (one-time [session-key](docs/session-keys.md) setup), `inspect-and-clean.ts` (list & cancel any open orders),
`one-ioc.ts` (place a single IOC order to test the full lifecycle).

## Networks

| | Mainnet | Shannon testnet |
| --- | --- | --- |
| Chain ID | `5031` | `50312` |
| RPC | `https://api.infra.mainnet.somnia.network` | `https://dream-rpc.somnia.network` |
| REST API | `https://api.dreamdex.io/v0` | `https://stg.api.dreamdex.io/v0` |
| WebSocket | `wss://api.dreamdex.io/v0/ws/public` | `wss://stg.api.dreamdex.io/v0/ws/public` |

Contract addresses are in [`packages/core`](packages/core) and always re-fetchable at runtime
from `GET /v0/markets` — never hard-code them in your own strategy.

## License & disclaimer

Licensed under the [MIT License](LICENSE) (© DreamDEX S.A.).

Please read the [**Legal Disclaimer**](DISCLAIMER.md) before using anything here. In short: this is
educational reference code — **not financial advice, and not audited.** Any strategy can lose funds.
You are responsible for the keys you load, the parameters you set, and the orders you sign. Test on
testnet first.
