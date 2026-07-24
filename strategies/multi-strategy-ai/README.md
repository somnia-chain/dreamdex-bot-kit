# multi-strategy-ai — modular ensemble + optional LLM

Combines the **modular Strategy / Orchestrator** pattern from
[`examples/02-modular-typescript`](../../examples/02-modular-typescript) with the
**classical ensemble → decision** idea from
[`examples/01-multi-strategy-ai`](../../examples/01-multi-strategy-ai), modernized
on [`@dreamdex-bot-kit/core`](../../packages/core).

Each cycle:

1. Sample mid (interval + WebSocket orderbook)
2. Run enabled analyzers: **momentum**, **mean-reversion** (RSI+BB), **grid**
3. Fuse with an OpenAI-compatible LLM (`FEATURES_AI=true`) or **majority vote**
4. Risk gate (circuit breaker + max risk %) → IOC via `Pool.place`
5. Manage one long with take-profit / stop-loss

## Run

```bash
cp strategies/multi-strategy-ai/.env.example strategies/multi-strategy-ai/.env
# set PRIVATE_KEY (or use repo-root .env); keep DRY_RUN=true
npm install
npm run dev -w multi-strategy-ai
```

Defaults to **`DRY_RUN=true`** and **`FEATURES_AI=false`** (vote-only, no API key needed).

## Feature flags

| Env | Default | Meaning |
| --- | --- | --- |
| `FEATURES_MOMENTUM` | `true` | Enable momentum analyzer |
| `FEATURES_MEAN_REVERSION` | `true` | Enable RSI + Bollinger analyzer |
| `FEATURES_GRID` | `true` | Enable range-position analyzer |
| `FEATURES_AI` | `false` | LLM fusion; otherwise majority vote |

## LLM (optional)

When `FEATURES_AI=true`, set an OpenAI-compatible endpoint:

```bash
FEATURES_AI=true
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# or local Ollama:
# OPENAI_BASE_URL=http://127.0.0.1:11434/v1
# OPENAI_API_KEY=ollama
# OPENAI_MODEL=llama3.2
```

On timeout / parse / HTTP errors the bot **falls back to majority vote** (fail-open to a deterministic decision, still gated by risk).

## Knobs

| Env | Default | Meaning |
| --- | --- | --- |
| `SYMBOL` | `WETH:USDso` | Market to trade |
| `MSA_LOOP_MS` | `60000` | Ensemble cycle interval |
| `MSA_NOTIONAL_USDSO` | `25` | Default order notional |
| `MSA_MAX_RISK_PERCENT` | `0.15` | Max fraction of free balance per trade |
| `MSA_MAX_LOSS_PERCENT` | `0.5` | Halt when cumulative PnL ≤ −this × starting equity |
| `DRY_RUN` | `true` | Log only; `false` to send transactions |

Trade attributions land under `strategies/multi-strategy-ai/data/`.

> Educational template, not financial advice — see [`../../DISCLAIMER.md`](../../DISCLAIMER.md).
