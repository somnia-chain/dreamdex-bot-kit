# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/main.py
import os, sys, threading
from agent.agent         import TradingAgent
from monitor.prices      import PriceFeed
from monitor.leaderboard import LeaderboardMonitor
from monitor.portfolio   import Portfolio
from monitor             import db as agent_db
from trading.manual      import ManualTrader
import server

def main():
    # Verify secrets
    from config import PRIVATE_KEY, ENV, FLASK_API_KEY
    assert PRIVATE_KEY, \
        "Set your wallet key: export TESTNET_PRIVATE_KEY=0x... (or MAINNET_PRIVATE_KEY for mainnet)"
    if not os.environ.get("OPENAI_KEY"):
        if ENV == "mainnet":
            # M1: hard refuse mainnet without OPENAI_KEY. Rule-based fallback fires real
            # trades with confidence=100 (bypassing the confidence gate) — too dangerous
            # with real money. Force the user to explicitly opt out by setting OPENAI_KEY=disable.
            if os.environ.get("OPENAI_KEY", "") != "disable":
                raise RuntimeError(
                    "OPENAI_KEY is unset on MAINNET. Rule-based fallback would trade with real money "
                    "and bypasses the confidence gate. Set OPENAI_KEY=<real key>, or "
                    "OPENAI_KEY=disable to acknowledge fallback-only operation."
                )
            print("[main] ⚠️  OPENAI_KEY=disable on mainnet — fallback only, will trade SOMI $1 every tick.")
        else:
            print("[main] ⚠️  OPENAI_KEY not set. Agent will run in Rule-Based Fallback mode.")
    if ENV == "mainnet" and not FLASK_API_KEY:
        # Belt-and-suspenders — server.init also checks this, but failing here gives a
        # clearer error message before any subsystem boots.
        raise RuntimeError("FLASK_API_KEY env var is REQUIRED on mainnet — set it before launch.")

    from config import SOMNIA_RPC, DREAMDEX_HTTP, MY_ADDRESS, FLASK_PORT
    print("="*55)
    print(f"  DreamDEX Trading Bot — {ENV.upper()} mode")
    print(f"  Wallet:  {MY_ADDRESS}")
    print(f"  RPC:     {SOMNIA_RPC}")
    print(f"  DEX API: {DREAMDEX_HTTP}")
    print(f"  Flask:   http://0.0.0.0:{FLASK_PORT}")
    print("="*55)

    # Init persistent memory (sqlite). Safe to call repeatedly; creates the
    # /app/data/agent.db file + tables if absent.
    agent_db.init()
    print("[main] sqlite memory initialised")

    # Init components
    prices    = PriceFeed()
    lb        = LeaderboardMonitor()
    portfolio = Portfolio()
    manual    = ManualTrader()

    # R9: parallel-agent orchestrator setup.
    # ONE DreamDEX (and therefore one SomniaWallet + one nonce lock) is shared
    # between both agents. The main agent runs the LLM loop (decide_pair, single
    # OpenAI call per tick) and forwards the second decision to the micro agent.
    # The micro agent is `brainless`: no autonomous loop, only executes what
    # the orchestrator hands it. Hard-pinned to PROFIT mode.
    from trading.dreamdex import DreamDEX
    from config import (MICRO_AGENT_MIN_TRADE, MICRO_AGENT_MAX_TRADE,
                        MICRO_AGENT_LOOP_SECS)
    shared_dex = DreamDEX()
    micro_agent = TradingAgent(
        portfolio=portfolio, lb=lb, dex=shared_dex,
        name="micro",
        min_trade=MICRO_AGENT_MIN_TRADE,
        max_trade=MICRO_AGENT_MAX_TRADE,
        loop_secs=MICRO_AGENT_LOOP_SECS,
        fixed_mode="profit",
        brainless=True,
    )
    agent = TradingAgent(
        portfolio=portfolio, lb=lb, dex=shared_dex,
        name="main",
        peer_agent=micro_agent,   # main is the orchestrator
    )

    # Wire: prices → both agents' analyzers
    prices.add_subscriber(agent.on_price_update)
    prices.add_subscriber(micro_agent.on_price_update)

    # Wire Flask (both agents)
    server.init(agent, prices, lb, portfolio, manual, micro=micro_agent)

    # Start background threads
    prices.start()      # REST poll every 30s
    lb.start()          # leaderboard every 5min
    portfolio.start()   # on-chain balance every 60s
    micro_agent.start() # brainless — no thread spawned, just marks running=True
    agent.start()       # main loop drives both agents

    # Flask blocks main thread
    server.run()


if __name__ == "__main__":
    main()
