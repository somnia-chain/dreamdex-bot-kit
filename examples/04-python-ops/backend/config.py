# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/config.py
import os
from dotenv import load_dotenv
load_dotenv()  # loads backend/.env automatically

# ── Network Mode ─────────────────────────────────────────
# Set DREAMDEX_ENV=mainnet when competition starts. Default = testnet.
ENV = os.environ.get("DREAMDEX_ENV", "testnet")

# ── Wallet keys (kept separate to avoid mixing testnet/mainnet funds) ────
# export TESTNET_PRIVATE_KEY=0x...   ← testnet deployer wallet
# export MAINNET_PRIVATE_KEY=0x...   ← competition wallet (set just before contest)

# Default address (overridden below per network)
MY_ADDRESS   = "0xe21c64a04562D53EA6AfFeB1c1561e49397B42dd"  # testnet deployer
PRIVATE_KEY  = ""  # resolved below per-network

# ── Capital Split ─────────────────────────────────────────
TOTAL_CAPITAL   = 50.0   # USDso
AGENT_CAPITAL   = 30.0
MANUAL_CAPITAL  = 20.0

# ── Agent Risk Rules ──────────────────────────────────────
AGENT_MIN_TRADE      = 7.00   # main agent min — any LLM-emitted amount below is clamped up
AGENT_MAX_TRADE      = 15.0   # main agent cap; supports bigger volume per fill
AGENT_STOP_BELOW     = 20.0   # capital floor; lowered to leave room for $15 main + $5 micro concurrent exposure

# Micro-agent (parallel, same wallet, shared nonce). Smaller faster trades so
# the leaderboard sees a steady stream of fills alongside the main agent's
# bigger swings.
MICRO_AGENT_MIN_TRADE = 2.0
MICRO_AGENT_MAX_TRADE = 5.0
MICRO_AGENT_LOOP_SECS = 90    # faster than main to keep tx-count rising
AGENT_CONFIDENCE_MIN = 65
MAX_CONCURRENT_POS   = 3
# Hard cap on total trades the agent will execute before auto-holding.
# 0 = unlimited. Adjustable at runtime via POST /agent/max_orders.
AGENT_MAX_ORDERS     = int(os.environ.get("AGENT_MAX_ORDERS", 100))
AGENT_FUNDING_SOURCE = os.environ.get("AGENT_FUNDING_SOURCE", "wallet")  # "vault" or "wallet" — wallet is the only path that actually fills on mainnet

# ── Timing ────────────────────────────────────────────────
AGENT_LOOP_SECONDS = int(os.environ.get("AGENT_LOOP_SECONDS", 300))
PRICE_POLL_SECONDS = 30
LEADERBOARD_POLL   = 300
PRICE_HISTORY_LEN  = 12

# ── OpenAI ────────────────────────────────────────────────
OPENAI_API   = "https://api.openai.com/v1"
OPENAI_MODEL = "gpt-4o-mini"

# ── Flask server ──────────────────────────────────────────
FLASK_HOST = "0.0.0.0"
FLASK_PORT = int(os.environ.get("FLASK_PORT", 5001))
# Shared-secret API key for mutating POST endpoints. Watch firmware sends it as X-API-Key header.
# Set via `export FLASK_API_KEY=<random>` before launching backend; same value in firmware/wifi_secrets.h.
# If empty AND ENV == "mainnet", server refuses to start. On testnet, missing key disables auth (dev mode).
FLASK_API_KEY = os.environ.get("FLASK_API_KEY", "")

# ── Leaderboard (mainnet-only, always) ────────────────────
# The competition leaderboard lives on mainnet regardless of which network
# the bot is currently trading on. We pin both the URL and the address that's
# looked up so testnet runs still surface our mainnet standing.
LEADERBOARD_URL     = "https://dreamdex-leaderboard-super-cool.vercel.app/api/leaderboard"
LEADERBOARD_ADDRESS = "0xF4c825F3C2970153d78B407CF190861dd4E2b905"  # mainnet wallet

# ═══════════════════════════════════════════════════════════
# NETWORK-SPECIFIC CONFIG
# ═══════════════════════════════════════════════════════════

if ENV == "mainnet":
    # ── Mainnet (Somnia, chain ID 5031) ───────────────────
    CHAIN_ID      = 5031
    SOMNIA_RPC    = "https://api.infra.mainnet.somnia.network/"
    DREAMDEX_HTTP = "https://api.dreamdex.io"
    DREAMDEX_WS   = "wss://api.dreamdex.io/v0/ws/public"

    MY_ADDRESS  = "0xF4c825F3C2970153d78B407CF190861dd4E2b905"  # competition wallet
    PRIVATE_KEY = os.environ.get("MAINNET_PRIVATE_KEY", "")    # export MAINNET_PRIVATE_KEY=0x...

    MARKETS = {
        "WETH:USDso": {
            "symbol":      "WETH:USDso",
            "ws_symbol":   "WETH-USDso",
            "contract":    "0xa936da11B57b50A344e1293AAaE5232885ea2bDE",
            "base":        "0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8",
            "quote":       "0x00000022dA000002656c64D9eA6011ea952D008A",
            "baseDecimals": 18,
            "quoteDecimals": 18,
            "gasSponsored": False,
            "native":       False,
        },
        "WBTC:USDso": {
            "symbol":      "WBTC:USDso",
            "ws_symbol":   "WBTC-USDso",
            "contract":    "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA",
            "base":        "0xC5098b3cA516784323872F17235fa074E167D3D2",
            "quote":       "0x00000022dA000002656c64D9eA6011ea952D008A",
            "baseDecimals": 8,
            "quoteDecimals": 18,
            "gasSponsored": False,
            "native":       False,
        },
        "SOMI:USDso": {
            "symbol":      "SOMI:USDso",
            "ws_symbol":   "SOMI-USDso",
            "contract":    "0x035De7403eac6872787779CCA7CCF1b4CDb61379",
            "base":        "0x0000000000000000000000000000000000000000",  # native
            "quote":       "0x00000022dA000002656c64D9eA6011ea952D008A",
            "baseDecimals": 18,
            "quoteDecimals": 18,
            "gasSponsored": True,
            "native":       True,   # use depositNative() + payable taker variant
        },
        "USDC.e:USDso": {
            "symbol":      "USDC.e:USDso",
            "ws_symbol":   "USDC.e-USDso",
            "contract":    "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b",
            "base":        "0x28BEc7E30E6faee657a03e19Bf1128AaD7632A00",
            "quote":       "0x00000022dA000002656c64D9eA6011ea952D008A",
            "baseDecimals": 6,
            "quoteDecimals": 18,
            "gasSponsored": True,
            "native":       False,
        },
    }

else:
    # ── Testnet (Somnia Shannon, chain ID 50312) ──────────
    CHAIN_ID      = 50312
    SOMNIA_RPC    = "https://api.infra.testnet.somnia.network"
    MY_ADDRESS    = "0xe21c64a04562D53EA6AfFeB1c1561e49397B42dd"  # testnet deployer wallet
    PRIVATE_KEY   = os.environ.get("TESTNET_PRIVATE_KEY", "")    # export TESTNET_PRIVATE_KEY=0x...
    DREAMDEX_HTTP = "https://stg.api.dreamdex.io"
    DREAMDEX_WS   = "wss://stg.api.dreamdex.io/v0/ws/public"

    # USDso on testnet (confirmed from sandbox scripts)
    USDSO_TESTNET = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171"

    # Testnet has 3 pairs only (no USDC.e)
    MARKETS = {
        "WETH:USDso": {
            "symbol":       "WETH:USDso",
            "ws_symbol":    "WETH-USDso",
            "contract":     "0xD180195da5459C7a0DEA188ed61216ec43682b50",
            "base":         "0x0000000000000000000000000000000000000000",  # query pool
            "quote":        USDSO_TESTNET,
            "baseDecimals":  18,
            "quoteDecimals": 18,
            "gasSponsored":  False,
            "native":        False,
        },
        "WBTC:USDso": {
            "symbol":       "WBTC:USDso",
            "ws_symbol":    "WBTC-USDso",
            "contract":     "0x3605f28aA7C50e7441211e77Cb0762d49539326C",
            "base":         "0x0000000000000000000000000000000000000000",
            "quote":        USDSO_TESTNET,
            "baseDecimals":  8,
            "quoteDecimals": 18,
            "gasSponsored":  False,
            "native":        False,
        },
        "SOMI:USDso": {
            "symbol":       "SOMI:USDso",
            "ws_symbol":    "SOMI-USDso",
            "contract":     "0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
            "base":         "0x0000000000000000000000000000000000000000",  # native STT
            "quote":        USDSO_TESTNET,
            "baseDecimals":  18,
            "quoteDecimals": 18,
            "gasSponsored":  True,
            "native":        True,
        },
    }

# Convenience: USDso address (same for quote in all pairs)
USDSO_ADDRESS = list(MARKETS.values())[0]["quote"]
