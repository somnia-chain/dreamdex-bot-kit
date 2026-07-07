# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/server.py
import os
from flask import Flask, jsonify, request, abort, send_from_directory
from config import FLASK_HOST, FLASK_PORT, MY_ADDRESS, FLASK_API_KEY, ENV
from monitor.prices      import PriceFeed
from monitor.leaderboard import LeaderboardMonitor
from monitor.portfolio   import Portfolio
from trading.manual      import ManualTrader

# Flask serves the static dashboard from backend/static/. The Lovable-generated
# index.html lives in firmware/index.html (canonical copy) and is mirrored into
# backend/static/ at sync time — see RUNBOOK § Dashboard updates.
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app = Flask(__name__, static_folder=_STATIC_DIR, static_url_path="/assets")

# ── C1 fix: shared-secret auth on every mutating endpoint ───────────
# Flask binds to 0.0.0.0 so the ESP32 can reach it. Without auth, any
# device on the same WiFi can POST /manual and trigger a mainnet trade.
# Watch firmware sends FLASK_API_KEY as X-API-Key header.
def require_api_key():
    """Abort with 401 if request doesn't carry a valid X-API-Key header.
    Mainnet: refuses if FLASK_API_KEY env var is empty (see init).
    Testnet with no key: dev mode — auth disabled."""
    if not FLASK_API_KEY:
        # Testnet dev mode: no key configured. Auth disabled. Mainnet
        # refuses to start without a key (see init()) so this branch is
        # safe on mainnet.
        return
    supplied = request.headers.get("X-API-Key", "")
    if supplied != FLASK_API_KEY:
        abort(401, description="missing or invalid X-API-Key")

# These are injected from main.py
_agent    = None
_micro    = None   # optional peer/sub agent
_prices   = None
_lb       = None
_portfolio= None
_manual   = None

def init(agent, prices, lb, portfolio, manual, micro=None):
    global _agent, _micro, _prices, _lb, _portfolio, _manual
    _agent=agent; _micro=micro; _prices=prices; _lb=lb
    _portfolio=portfolio; _manual=manual
    # C1: refuse mainnet start with empty key — fail closed instead of fail open.
    if ENV == "mainnet" and not FLASK_API_KEY:
        raise RuntimeError(
            "FLASK_API_KEY env var is REQUIRED on mainnet (set a random string; "
            "set the same value in firmware/wifi_secrets.h as API_KEY)"
        )

# ── Dashboard (single-page HTML control panel) ─────────────
@app.route("/")
def dashboard():
    """Serves the single-page dashboard at https://<host>/."""
    return send_from_directory(_STATIC_DIR, "index.html")


# ── Endpoints the ESP32 calls ──────────────────────────────

@app.route("/prices")
def prices():
    """All 4 pairs, latest mid/bid/ask"""
    return jsonify(_prices.latest())

@app.route("/agent")
def agent_status():
    """Main agent status — what it's doing right now"""
    return jsonify(_agent.get_status())

@app.route("/agent/micro")
def agent_micro_status():
    """Sub-agent (micro) status. 404 when no parallel agent is running."""
    if _micro is None:
        return jsonify({"error": "no micro agent configured"}), 404
    return jsonify(_micro.get_status())

@app.route("/portfolio")
def portfolio():
    """My balances, P&L, open positions"""
    return jsonify(_portfolio.summary())

@app.route("/leaderboard")
def leaderboard():
    """My position only"""
    return jsonify(_lb.get_my_stats())

@app.route("/direct_burst")
def direct_burst_status():
    """Direct-RPC burst status — read from stats file written by direct_burst.py.
    Returns {} with `available: false` if no stats file exists yet."""
    import json
    import time as _time
    path = os.environ.get("BURST_STATS_PATH", "/tmp/direct_burst_stats.json")
    try:
        with open(path, "r") as fh:
            stats = json.load(fh)
        now = _time.time()
        last_age = now - stats.get("last_action_ts", 0)
        stats["last_action_ago_s"] = round(last_age, 1)
        stats["running"] = last_age < 30  # alive if stats updated < 30s ago
        stats["available"] = True
        return jsonify(stats)
    except FileNotFoundError:
        return jsonify({"available": False, "running": False,
                        "reason": "no stats file yet"})
    except Exception as e:
        return jsonify({"available": False, "running": False,
                        "error": str(e)[:120]})


@app.route("/burst")
def burst_status():
    """Burst loop status — derived from manual-mode trades in DB.
    Read-only. No auth required (status, not control)."""
    import sqlite3
    import time as _time
    from monitor.db import _DB_PATH
    now = _time.time()
    out = {
        "running": False,
        "last_fill_ago_s": None,
        "fills_1m": 0,
        "fills_5m": 0,
        "fills_1h": 0,
        "fills_total": 0,
        "leg_size": None,
        "volume_1h": 0.0,
    }
    try:
        with sqlite3.connect(_DB_PATH, timeout=5.0) as conn:
            c = conn.cursor()
            c.execute(
                "SELECT COUNT(*), MAX(ts) FROM trades "
                "WHERE mode = 'manual' AND status = 'success' AND ts > ?",
                (now - 60,),
            )
            r1 = c.fetchone()
            out["fills_1m"] = r1[0]
            last_ts = r1[1]
            for window_s, key in ((300, "fills_5m"), (3600, "fills_1h")):
                c.execute(
                    "SELECT COUNT(*) FROM trades "
                    "WHERE mode = 'manual' AND status = 'success' AND ts > ?",
                    (now - window_s,),
                )
                out[key] = c.fetchone()[0]
            c.execute(
                "SELECT COUNT(*) FROM trades WHERE mode = 'manual' AND status = 'success'"
            )
            out["fills_total"] = c.fetchone()[0]
            c.execute(
                "SELECT amount_usdso FROM trades "
                "WHERE mode = 'manual' AND status = 'success' "
                "ORDER BY ts DESC LIMIT 20"
            )
            recent = [r[0] for r in c.fetchall() if r[0] is not None]
            if recent:
                out["leg_size"] = round(sum(recent) / len(recent), 2)
                out["volume_1h"] = round(out["fills_1h"] * out["leg_size"], 2)
        if last_ts:
            out["last_fill_ago_s"] = round(now - last_ts, 1)
            out["running"] = out["last_fill_ago_s"] < 60
    except Exception as e:
        out["error"] = str(e)[:120]
    return jsonify(out)

@app.route("/manual", methods=["POST"])
def manual_trade():
    """ESP32 button triggers a manual trade. AUTHED."""
    require_api_key()
    data = request.json
    # data = {"pair": "WETH:USDso", "side": "buy", "amount_usdso": 2.0}
    result = _manual.execute(
        pair       = data["pair"],
        side       = data["side"],
        amount_usdso = float(data["amount_usdso"]),
        prices     = _prices.latest(),
        skip_sim   = bool(data.get("skip_sim", False)),
    )
    return jsonify(result)

@app.route("/agent/speed", methods=["POST"])
def set_speed():
    """ESP32 config menu changes agent speed. AUTHED."""
    require_api_key()
    speed = request.json.get("speed", "normal")
    _agent.set_speed(speed)
    return jsonify({"ok": True, "speed": speed})

@app.route("/agent/toggle", methods=["POST"])
def toggle_agent():
    """Pause or resume agent. AUTHED."""
    require_api_key()
    if _agent.paused:
        _agent.resume()
        return jsonify({"status": "resumed"})
    else:
        _agent.pause()
        return jsonify({"status": "paused"})

@app.route("/agent/max_orders", methods=["POST"])
def set_max_orders():
    """ESP32 config menu sets the order budget (0 = unlimited). AUTHED."""
    require_api_key()
    n = int(request.json.get("max_orders", 0))
    _agent.set_max_orders(n)
    return jsonify({"ok": True, "max_orders": _agent.max_orders})

@app.route("/agent/stats", methods=["GET"])
def agent_stats():
    """Aggregate trade memory from sqlite — totals, per-pair PnL, last 20 trades."""
    from monitor import db as agent_db
    return jsonify(agent_db.stats_summary())

@app.route("/agent/mode", methods=["GET", "POST"])
def agent_mode():
    """Switch brain strategy. AUTHED on POST.
    Accepts 'grind' / 'profit' (sticky manual override) or 'auto' (rank-based flip).
    GET returns the effective mode + whether auto-flip is active."""
    from agent import brain
    if request.method == "GET":
        return jsonify({
            "mode":     brain.get_mode(),  # effective: grind or profit
            "auto":     brain.is_auto(),
            "selected": "auto" if brain.is_auto() else brain.get_mode(),
        })
    require_api_key()
    mode = request.json.get("mode", "grind")
    try:
        brain.set_mode(mode)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({
        "ok":       True,
        "mode":     brain.get_mode(),
        "auto":     brain.is_auto(),
        "selected": "auto" if brain.is_auto() else brain.get_mode(),
    })

@app.route("/vault/deposit", methods=["POST"])
def vault_deposit():
    """Deposit funds into the SpotPool vault. AUTHED."""
    require_api_key()
    data = request.json
    try:
        tx_hash = _manual.dex.vault_deposit(
            symbol=data["pair"],
            token_addr=data["token"],
            amount=float(data["amount"])
        )
        return jsonify({"status": "success", "tx_hash": tx_hash})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 400

@app.route("/vault/withdraw", methods=["POST"])
def vault_withdraw():
    """Withdraw funds from the SpotPool vault. AUTHED."""
    require_api_key()
    data = request.json
    try:
        tx_hash = _manual.dex.vault_withdraw(
            symbol=data["pair"],
            token_addr=data["token"],
            amount=float(data["amount"])
        )
        return jsonify({"status": "success", "tx_hash": tx_hash})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 400

@app.route("/wifi_scan")
def wifi_scan():
    """ESP32 asks for known networks (just returns config)"""
    return jsonify({"known": ["Home_Network", "iPhone_Hotspot"]})

def run():
    app.run(host=FLASK_HOST, port=FLASK_PORT, 
            debug=False, use_reloader=False)
