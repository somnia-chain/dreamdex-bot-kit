# dreamBot Kit

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
| [`packages/backtest`](packages/backtest) | Bar-by-bar backtest engine (`SimPool`, fill model, metrics). Drive it with `npm run backtest` — see [docs/backtesting.md](docs/backtesting.md). |
| [`strategies/`](strategies) | Start with [`starter`](strategies/starter) — the simplest bot, where you edit one `decide()` function. Then full strategies: [market-making](strategies/market-making), [grid](strategies/grid), [momentum](strategies/momentum), [mean-reversion](strategies/mean-reversion), [twap](strategies/twap) (execution algo), and [ensemble](strategies/ensemble) (modular ensemble + optional LLM). Each is clone → configure → run, with its own README explaining the trade-offs. |
| [`strategies/ec-*`](strategies) | The same idea on **event contracts** — binary Up/Down markets on BTC and ETH price, trading on the same order book through a different SDK: [ec-starter](strategies/ec-starter), [ec-maker](strategies/ec-maker), [ec-passive](strategies/ec-passive), [ec-laddering-bot](strategies/ec-laddering-bot), [ec-oracle-follow](strategies/ec-oracle-follow), [ec-settlement](strategies/ec-settlement). They share the repo and the Railway entrypoint with the spot bots and nothing else; see [docs/event-contracts.md](docs/event-contracts.md) first, because the sharp edges are different. |
| [`strategies/perp-*`](strategies) | **Perpetual futures** on the Hideki testnet: [perp-starter](strategies/perp-starter), [perp-maker](strategies/perp-maker), [perp-funding](strategies/perp-funding), [perp-guard](strategies/perp-guard). They can trade your DreamDEX account through a bot key you link in the app, which can place and cancel orders but never withdraw; see [docs/perps.md](docs/perps.md). |
| [`docs/`](docs) | The bot-specific knowledge the protocol docs don't cover: [getting started](docs/getting-started.md), [architecture](docs/architecture.md), [gotchas](docs/gotchas.md), [backtesting](docs/backtesting.md), [running 24/7](docs/24-7-operations.md), [session keys](docs/session-keys.md) (run a bot with a hot key that can't withdraw funds), [Railway deploy](docs/railway.md), [event contracts](docs/event-contracts.md), [perps](docs/perps.md). |
| [`advanced/batch-7702`](advanced/batch-7702) | A **technique demo** (not a trading strategy): how to use EIP-7702 to batch multiple actions into a single transaction. |
| [`tools/edge-analytics`](tools/edge-analytics) | An **analysis tool** (not a bot): measures whether a maker actually has an edge — captured spread vs adverse selection vs transactions-per-fill — from your own fills. Methodology in [docs/measuring-edge.md](docs/measuring-edge.md). |
| [`examples/`](examples) | The real competition bots, sanitized to core code. Different architectures, languages, and tricks — read them to see how people actually did it. |
| [`skills/`](skills) | [Agent Skills](skills) so an AI coding agent can build DreamDEX bots with the right context: a general [`somnia`](skills/somnia) skill and a [`dreamdex-bot`](skills/dreamdex-bot) skill (the core API, gotchas, and session keys). |

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

**Fastest path — a bot running in ~60s:**

```bash
git clone <this repo> && cd dreamdex-bot-kit
npm install
npm run quickstart                # 3 questions → writes a safe dry-run .env
npm run dev -w starter            # runs in DRY_RUN: logs orders, sends nothing
```

`quickstart` defaults to the [`starter`](strategies/starter) strategy — the
simplest bot, where you edit **one function** (`decide()`) and the harness does
the rest. Watch the dry-run logs, then edit `.env` to add your own funded key and
set `DRY_RUN=false`.

**Manual setup** (any strategy):

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
npm run dev -w market-making      # or: grid · momentum · mean-reversion · twap · ensemble
```

**Backtest first** (no private key required — historical candles + simulated fills):

```bash
npm run backtest -- review --symbol WETH:USDso --interval 5m --days 7
npm run backtest -- run momentum --days 3 --quiet
```

See [docs/backtesting.md](docs/backtesting.md) for the full CLI, cost model, and how to add an adapter.

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

**Deploy on Railway (24/7 worker, no local Node):** see [docs/railway.md](docs/railway.md).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/pE6EIF)

### Helper scripts

Small read-only / cleanup utilities in [`scripts/`](scripts) (run with `npx tsx scripts/<name>.ts`):
`doctor.ts` (setup + balance check), `operator-setup.ts` (one-time [session-key](docs/session-keys.md) setup), `inspect-and-clean.ts` (list & cancel any open orders),
`one-ioc.ts` (place a single IOC order to test the full lifecycle), `backtest.ts` ([historical replay](docs/backtesting.md) — also `npm run backtest`),
`order-history.ts` (market-wide order + fill history for a time window, from the markets indexer — `SYMBOL=USDC.e:USDso FROM=2026-10-02 npx tsx scripts/order-history.ts`).

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
