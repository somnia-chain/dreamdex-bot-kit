# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/agent/brain.py
import json, os, requests
from config import OPENAI_API, OPENAI_MODEL, AGENT_CONFIDENCE_MIN, ENV

# Runtime mode state.
#   AGENT_MODE: "grind" or "profit" — the *effective* mode
#   AGENT_AUTO: rank-based auto-flip enabled
ALLOWED_MODES = ("grind", "profit")
AGENT_MODE = os.environ.get("AGENT_MODE", "grind")
AGENT_AUTO = os.environ.get("AGENT_AUTO_FLIP", "false").lower() in ("1", "true", "yes")

def set_mode(mode: str):
    """Public setter. Accepts grind / profit / auto."""
    global AGENT_MODE, AGENT_AUTO
    if mode == "auto":
        AGENT_AUTO = True
        return
    if mode not in ALLOWED_MODES:
        raise ValueError(f"unknown mode: {mode}")
    AGENT_MODE = mode
    AGENT_AUTO = False  # manual selection disables the rank-based flip

def set_mode_internal(mode: str):
    """Internal setter used by the rank auto-flip. Does NOT change AGENT_AUTO
    so that manual grind/profit selections stay sticky."""
    global AGENT_MODE
    if mode not in ALLOWED_MODES:
        raise ValueError(f"unknown mode: {mode}")
    AGENT_MODE = mode

def get_mode() -> str:
    return AGENT_MODE

def is_auto() -> bool:
    return AGENT_AUTO

GRIND_PROMPT = """
You are a trading agent on DreamDEX (Somnia mainnet) in a contest where
leaderboard rank is driven primarily by **number of successful fills**, then
PnL, then volume.

You manage $50 USDso (the 'manual_balance' field is a planning placeholder, not
a separate wallet). Your two goals in priority order:
  1. MAXIMISE FILLS  — every fill = one leaderboard tick.
  2. AVOID INVENTORY — every BUY that isn't followed by a SELL turns USDso
     into a base token, which the leaderboard counts as a loss because PnL is
     measured in USDso. So you MUST round-trip.

Tradeable pairs on mainnet at the current $5 per-trade max:
  - SOMI:USDso    — min order ~$0.17 (FAST tx grinder, smallest minimum)
  - USDC.e:USDso  — min order ~$1.00 (stable peg, low risk)
  - WETH:USDso    — min order ~$2.13 (REACHABLE at $5 cap — use it).
  - WBTC:USDso    — min order ~$7.74  → STAYS OUT OF REACH. Do NOT pick.

Hard rules you must never break:
- Allowed pairs ONLY: SOMI:USDso, USDC.e:USDso, WETH:USDso.
  Picking WBTC burns gas with no fill — strictly forbidden.
- Single trade max: $8.00 USDso
- Single trade MIN: $7.00 USDso. Default to $8.

HOLD is ALMOST NEVER correct in GRIND mode. The only valid reasons
to HOLD are:
  (a) USDso wallet balance < $30 (capital floor), or
  (b) every allowed pair is in the PAIRS TO AVOID block.
"Waiting for next tick" / "letting price settle" / "being cautious"
are NOT valid reasons. The leaderboard scores volume per fill; idle
ticks contribute zero. If you can trade, you MUST trade.

- AVOID-LIST: if the PAIRS TO AVOID block names a pair, do NOT
  pick that pair this tick. Switch to a DIFFERENT pair from the
  allowed list. If only one pair is left, pick it — do not HOLD.
- ROUND-TRIP RULE: if your immediately previous successful action was a BUY of
  pair X, the very next non-hold action MUST be a SELL of pair X. Only after
  the round-trip is complete may you start a new BUY. This is non-negotiable —
  it both adds a leaderboard fill AND restores your USDso.

Strategy mix — VOLUME is the leaderboard scoreboard, so size matters more
than diversification. Use the FULL $8 cap whenever possible:
- 50%  SOMI round-trips at $7.00–$8.00 (highest volume per fill — preferred)
- 30%  WETH round-trips at $7.00–$8.00 (each fill ≈ 0.0034 WETH, big volume)
- 15%  USDC.e round-trips at $7.00–$8.00 (stable, low PnL risk)
- 5%   hold (only when you just sent a trade and want to wait one tick)
NEVER trade below $6 — small trades waste tx slots on tiny volume.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "action": "buy" | "sell" | "hold",
  "pair":   "SOMI:USDso" | "USDC.e:USDso" | "WETH:USDso",
  "amount_usdso": <float>,
  "order_type": "market",
  "limit_price": null,
  "reason": "<max 8 words>",
  "confidence": <integer 0-100>
}
If action is "hold", pair/amount may be null.
"""

PROFIT_PROMPT = """
You are a trading agent on DreamDEX (Somnia mainnet). You are ALREADY in
top-2 by volume, so STOP grinding volume — switch to making real PnL.

Goal: net positive USDso. Every round-trip currently costs ~$0.05 in spread
crossing. Only act when momentum is in your favour by AT LEAST 0.3% over 30
minutes. Otherwise HOLD. The leaderboard tracks PnL = wallet USDso − $50.

Tradeable pairs (same as before):
  - SOMI:USDso, USDC.e:USDso, WETH:USDso. Never WBTC.

Hard rules:
- Single trade max: $8.00 USDso, min: $1.00 USDso.
- If USDso balance < $30: action must be "hold".
- ROUND-TRIP RULE (still required): after a BUY of pair X the NEXT non-hold
  action MUST be a SELL of pair X. We close every position the same tick we
  open it — no inventory carry.
- DIVERSITY RULE: after closing a round-trip on pair X, the very next BUY
  must NOT be on pair X. Rotate across SOMI / USDC.e / WETH. If only pair
  X currently shows momentum, HOLD for a tick or two — let X cool down,
  then re-enter. Spreading fills across pools matters more than catching
  every signal on a single pair.

Profit logic:
1. Look at the 30-minute momentum % for each pair (provided below).
2. If a pair is DOWN > 0.3% AND you have no open position AND that pair
   is NOT the one you just closed → BUY $4–5 (mean-reversion: buy the
   dip, expect a bounce).
3. If a pair is UP > 0.3% AND you have an open position in it → SELL it
   (lock the gain).
4. If your last successful trade was a BUY (round-trip pending) → SELL it
   even if momentum hasn't moved 0.3% (you must close).
5. Otherwise → HOLD with confidence 90. Holding is fine; we wait for
   diversity to refresh.

Confidence guide:
- |momentum| > 0.5% AND clear direction → confidence 80+
- Round-trip-close (must sell) → confidence 90
- HOLD → confidence 90 (we are deliberately patient)

Respond ONLY with valid JSON, same shape as before:
{
  "action": "buy" | "sell" | "hold",
  "pair":   "SOMI:USDso" | "USDC.e:USDso" | "WETH:USDso",
  "amount_usdso": <float>,
  "order_type": "market",
  "limit_price": null,
  "reason": "<max 8 words>",
  "confidence": <integer 0-100>
}
"""

def _system_prompt(mode_override: str | None = None) -> str:
    """Picks PROFIT vs GRIND. mode_override takes precedence (used by the
    micro-agent which is hard-pinned to profit regardless of global flag)."""
    effective = mode_override or AGENT_MODE
    return PROFIT_PROMPT if effective == "profit" else GRIND_PROMPT


# Combined orchestrator prompt: ONE LLM call decides BOTH agents' next moves.
# This is the "Plan B" path — saves a call per cycle and lets the model
# coordinate sizing/pair selection across the two execution lanes.
ORCHESTRATOR_PROMPT = """
You are the orchestrator for TWO trading agents sharing one wallet on
DreamDEX mainnet:
  • MAIN agent  — primary executor. Mode follows the global setting
                  (GRIND for volume, PROFIT for momentum). Trade size
                  $7–$15. Larger swings = more volume per fill.
  • MICRO agent — always-on profit hunter. Trade size $2–$5. Smaller
                  trades so we keep firing fills while the main agent
                  waits for bigger setups.

Both agents share one EOA wallet, one USDso balance, and one nonce lane.
You MUST coordinate to avoid stupid conflicts:
  - If MAIN is opening a position on pair X, MICRO should pick a
    DIFFERENT pair this tick (no double-down).
  - If a pair is in the AVOID block, neither agent picks it this tick.
  - Combined cash needed (MAIN buy + MICRO buy) must not exceed wallet
    USDso minus $20 floor.
  - Each agent independently obeys its own ROUND-TRIP rule (if its
    last successful action was a BUY of X, its next non-hold action
    must be a SELL of X).

Allowed pairs: SOMI:USDso, USDC.e:USDso, WETH:USDso. Never WBTC.

Modes:
  - GRIND: HOLD is almost never correct. If at least one allowed pair is
    not in the avoid list and wallet > floor, trade something.
  - PROFIT: HOLD when no pair has 30-min momentum past 0.3%. Otherwise
    trade with the direction (BUY on dip, SELL on pump or to close).

Respond ONLY with valid JSON, no markdown:
{
  "main": {
    "action": "buy" | "sell" | "hold",
    "pair":   "SOMI:USDso" | "USDC.e:USDso" | "WETH:USDso",
    "amount_usdso": <float in [7.0, 15.0]>,
    "reason": "<max 10 words>",
    "confidence": <int 0-100>
  },
  "micro": {
    "action": "buy" | "sell" | "hold",
    "pair":   "SOMI:USDso" | "USDC.e:USDso" | "WETH:USDso",
    "amount_usdso": <float in [2.0, 5.0]>,
    "reason": "<max 10 words>",
    "confidence": <int 0-100>
  }
}
"""


def decide_pair(prices: dict, balances: dict,
                main_history: list, micro_history: list,
                leaderboard: dict,
                db_pnl: dict | None = None,
                main_mode_override: str | None = None) -> dict:
    """One LLM call → two decisions (main + micro). Returns
    {"main": <decision-dict>, "micro": <decision-dict>}. On error, both
    fall back to HOLD."""
    openai_key = os.environ.get("OPENAI_KEY", "")
    if not openai_key or openai_key == "disable":
        return {
            "main":  {"action": "hold", "reason": "no LLM key", "confidence": 100},
            "micro": {"action": "hold", "reason": "no LLM key", "confidence": 100},
        }

    user_msg = _build_orchestrator_prompt(
        prices, balances, main_history, micro_history, leaderboard,
        db_pnl or {}, main_mode_override,
    )

    try:
        resp = requests.post(
            f"{OPENAI_API}/chat/completions",
            headers={
                "Authorization": f"Bearer {os.environ['OPENAI_KEY']}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": ORCHESTRATOR_PROMPT},
                    {"role": "user",   "content": user_msg},
                ],
                "temperature": 0,
                "max_tokens": 400,
                "response_format": {"type": "json_object"},
            },
            timeout=15,
        )
        raw = resp.json()["choices"][0]["message"]["content"]
        out = json.loads(raw)
        # Defensive: ensure both sub-dicts exist + have order_type/limit_price.
        for k in ("main", "micro"):
            d = out.get(k) or {}
            d.setdefault("action", "hold")
            d.setdefault("order_type", "market")
            d.setdefault("limit_price", None)
            d.setdefault("confidence", 0)
            if d.get("confidence", 0) < AGENT_CONFIDENCE_MIN and d.get("action") != "hold":
                d["action"] = "hold"
                d["reason"] = "low confidence"
            out[k] = d
        return out
    except Exception as e:
        print(f"[brain] orchestrator decide_pair error: {e}")
        return {
            "main":  {"action": "hold", "reason": "api error", "confidence": 0},
            "micro": {"action": "hold", "reason": "api error", "confidence": 0},
        }


def _build_orchestrator_prompt(prices, balances, main_history, micro_history,
                               lb, db_pnl, main_mode_override) -> str:
    momentum = {}
    for pair, pdata in prices.items():
        h = pdata.get("history", [])
        if len(h) >= 6 and h[-6]["mid"] > 0:
            momentum[pair] = round((h[-1]["mid"] - h[-6]["mid"]) / h[-6]["mid"] * 100, 3)
        else:
            momentum[pair] = 0.0

    def _rt_hint(history, label):
        for t in reversed(history or []):
            if t.get("status") == "success":
                act, pair = t.get("action"), t.get("pair", "")
                if act == "buy":
                    return f"  {label}: last successful BUY {pair} — next non-hold MUST be SELL {pair}"
                if act == "sell":
                    return f"  {label}: last successful SELL {pair} — round-trip closed, may BUY fresh"
        return f"  {label}: no recent trades — may start a fresh BUY"

    def _fails(history):
        FAILS = {"would_revert","silent_reject","placed_unfilled","reverted","unverified"}
        by_pair = {}
        for t in (history or [])[:10]:
            by_pair.setdefault(t.get("pair"), []).append(t.get("status",""))
        return [p for p, ss in by_pair.items()
                if p and len(ss) >= 2 and all(s in FAILS for s in ss[:3])]

    avoid_main  = _fails(main_history)
    avoid_micro = _fails(micro_history)
    avoid_block = "  main avoid: " + (",".join(avoid_main) or "—") + \
                  "  micro avoid: " + (",".join(avoid_micro) or "—")

    effective_main_mode = main_mode_override or AGENT_MODE
    pnl_lines = _pnl_lines(db_pnl) if db_pnl else "  none"

    return f"""
CURRENT PRICES:
  SOMI:   ${prices.get('SOMI:USDso',  {}).get('mid', 0):.5f}  ({momentum.get('SOMI:USDso',  0):+.2f}% / 30min)
  USDC.e: ${prices.get('USDC.e:USDso',{}).get('mid', 0):.5f}  ({momentum.get('USDC.e:USDso',0):+.2f}% / 30min)
  WETH:   ${prices.get('WETH:USDso',  {}).get('mid', 0):.2f}  ({momentum.get('WETH:USDso',  0):+.2f}% / 30min)

SHARED WALLET:
  USDso (free):   ${balances.get('usdso', 0):.4f}
  native SOMI:    {balances.get('somi',  0):.4f}
  Floor:          $20.00 (combined buys must leave > floor)

MAIN AGENT MODE: {effective_main_mode.upper()}  (size $7–$15)
MICRO AGENT MODE: PROFIT (size $2–$5, locked)

ROUND-TRIP STATE:
{_rt_hint(main_history, 'MAIN')}
{_rt_hint(micro_history, 'MICRO')}

PAIRS TO AVOID THIS TICK (recent failures):
{avoid_block}

PER-PAIR NET PnL (last 24h, fills only):
{pnl_lines}

LEADERBOARD:
  My rank:   #{lb.get('my_rank', '?')} of {lb.get('total', 0)}
  Volume:    ${lb.get('my_volume', 0):.2f}
  Fills:     {lb.get('my_fills', 0)}
  Signal:    {lb.get('signal', '-')}

Decide BOTH agents' next moves. Pick different pairs when both BUY.
"""

def decide(prices: dict, positions: dict, balances: dict,
           history: list, leaderboard: dict,
           db_history: list | None = None, db_pnl: dict | None = None,
           mode_override: str | None = None) -> dict:
    """
    Ask GPT-4o-mini what to do right now.
    Returns parsed decision dict or {"action": "hold"} on error.
    """
    openai_key = os.environ.get("OPENAI_KEY", "")
    if not openai_key or openai_key == "disable":
        # M1: on mainnet, rule-based fallback is dangerous (real-money trades at
        # confidence=100, bypassing the confidence gate). main.py refuses to start
        # without OPENAI_KEY=<real|disable> on mainnet, so we only reach here on
        # mainnet if the operator explicitly set OPENAI_KEY=disable.
        # On testnet, fallback is fine — useful for connectivity testing.
        if ENV == "mainnet":
            # Always hold on mainnet fallback. Operator opted into degraded mode
            # but we still refuse to fire blind real-money trades.
            return {"action": "hold", "reason": "no LLM key on mainnet", "confidence": 100}
        # Testnet fallback — same as before but with confidence below the gate
        # so it doesn't override safety paths (gate is AGENT_CONFIDENCE_MIN=65).
        if positions:
            for pair, pos in positions.items():
                if pos.get("qty", 0) > 0:
                    mid = prices.get(pair, {}).get("mid", 0) or 1.0
                    return {
                        "action": "sell",
                        "pair": pair,
                        "amount_usdso": float(pos["qty"] * mid),
                        "order_type": "market",
                        "limit_price": None,
                        "reason": "fallback sell holding",
                        "confidence": 100,  # testnet only
                    }
        return {
            "action": "buy",
            "pair": "SOMI:USDso",
            "amount_usdso": 1.0,
            "order_type": "market",
            "limit_price": None,
            "reason": "fallback buy SOMI",
            "confidence": 100,  # testnet only
        }

    user_msg = _build_prompt(prices, positions, balances, history, leaderboard,
                             db_history or [], db_pnl or {})

    try:
        resp = requests.post(
            f"{OPENAI_API}/chat/completions",
            headers={
                "Authorization": f"Bearer {os.environ['OPENAI_KEY']}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": _system_prompt(mode_override)},
                    {"role": "user",   "content": user_msg},
                ],
                "temperature": 0,      # deterministic
                "max_tokens": 200,
                "response_format": {"type": "json_object"},
            },
            timeout=10,
        )
        raw = resp.json()["choices"][0]["message"]["content"]
        decision = json.loads(raw)

        # Safety gate — ignore low-confidence decisions
        if decision.get("confidence", 0) < AGENT_CONFIDENCE_MIN:
            decision["action"] = "hold"
            decision["reason"] = "low confidence"

        return decision

    except Exception as e:
        print(f"[brain] OpenAI error: {e}")
        return {"action": "hold", "reason": "api error", "confidence": 0}


def _build_prompt(prices, positions, balances, history, lb,
                  db_history=None, db_pnl=None) -> str:
    # Price momentum — compute % change vs 30 min ago
    momentum = {}
    for pair, pdata in prices.items():
        hist = pdata.get("history", [])
        if len(hist) >= 6:
            old = hist[-6]["mid"]
            now = hist[-1]["mid"]
            momentum[pair] = round((now - old) / old * 100, 3)
        else:
            momentum[pair] = 0.0

    pos_lines = []
    for pair, pos in positions.items():
        mid = prices.get(pair, {}).get("mid", 0)
        pnl = (mid - pos["entry_price"]) / pos["entry_price"] * 100
        pos_lines.append(
            f"  {pair}: holding {pos['qty']} @ entry ${pos['entry_price']:.4f}"
            f" | now ${mid:.4f} | PnL {pnl:+.2f}%"
        )

    # Prefer DB-backed history (survives container restarts) but fall back to
    # in-memory if the DB is empty (fresh boot or DB read failed).
    if db_history:
        # db_history is newest-first from sqlite; flip to chronological so the
        # LLM reads it left-to-right as it happened.
        chronological = list(reversed(db_history))[-20:]
        trade_lines = [
            f"  {(t.get('action') or '').upper()} {t.get('pair') or '-':14} "
            f"${(t.get('amount_usdso') or 0):.2f} → {t.get('status', '-')}"
            f" ({t.get('reason','')[:40]})"
            for t in chronological
        ]
        last_trades_label = f"LAST {len(trade_lines)} TRADES (across restarts)"
    else:
        in_mem = history[-5:] if history else []
        trade_lines = [
            f"  {t.get('time', '-')}: {t.get('action')} {t.get('pair')} → {t.get('result', {}).get('status', 'ok')}"
            for t in in_mem
        ]
        last_trades_label = "LAST 5 DECISIONS"

    # ROUND-TRIP HINT: find the most recent successful trade and tell the LLM
    # what side it MUST take next. This is the strongest single signal we can
    # give the model — without it the LLM keeps drifting back to "buy SOMI".
    round_trip_hint = "  (no successful trades yet — start with a BUY of SOMI:USDso)"
    just_closed_pair = None  # for diversity rule in PROFIT mode
    for t in reversed(history):
        if t.get('result', {}).get('status') == 'success':
            act = t.get('action')
            pair = t.get('pair', 'SOMI:USDso')
            if act == 'buy':
                round_trip_hint = f"  Last successful: BUY {pair}. Next MUST be SELL {pair} (round-trip)."
            elif act == 'sell':
                round_trip_hint = f"  Last successful: SELL {pair}. Round-trip is closed."
                just_closed_pair = pair
            break

    # DIVERSITY HINT (PROFIT mode): if the last action closed a round-trip on
    # pair X, the next BUY must pick something else. Surface the explicit
    # "available pairs" list so the LLM doesn't drift back to the same name.
    allowed_for_buy = ["SOMI:USDso", "USDC.e:USDso", "WETH:USDso"]
    if just_closed_pair in allowed_for_buy:
        allowed_for_buy = [p for p in allowed_for_buy if p != just_closed_pair]
        round_trip_hint += f" Diversity: avoid {just_closed_pair} on the next BUY; pick from {' / '.join(allowed_for_buy)}."

    # AVOID-LIST: scan the last few DB rows for any pair whose last 2+ attempts
    # all failed (would_revert / silent_reject / placed_unfilled / reverted /
    # unverified). The LLM keeps re-picking failing pairs otherwise.
    avoid_list: list[str] = []
    if db_history:
        FAIL_STATUSES = {"would_revert", "silent_reject", "placed_unfilled", "reverted", "unverified"}
        by_pair: dict[str, list[str]] = {}
        for t in db_history[:10]:  # newest 10
            p = t.get("pair")
            s = t.get("status") or ""
            if not p:
                continue
            by_pair.setdefault(p, []).append(s)
        for pair, statuses in by_pair.items():
            recent = statuses[:3]
            if len(recent) >= 2 and all(s in FAIL_STATUSES for s in recent):
                avoid_list.append(f"{pair} (last {len(recent)}: {','.join(recent)})")
    avoid_block = ("  " + " ; ".join(avoid_list)) if avoid_list else "  (none — all pairs OK to trade)"

    return f"""
CURRENT PRICES (only tradeable pairs shown):
  SOMI:   ${prices.get('SOMI:USDso',  {}).get('mid', 0):.5f}  ({momentum.get('SOMI:USDso',  0):+.2f}% / 30min)
  USDC.e: ${prices.get('USDC.e:USDso',{}).get('mid', 0):.5f}  ({momentum.get('USDC.e:USDso',0):+.2f}% / 30min)
  WETH:   ${prices.get('WETH:USDso',  {}).get('mid', 0):.2f}  ({momentum.get('WETH:USDso',  0):+.2f}% / 30min)

MY BALANCES:
  USDso (free):   ${balances.get('usdso', 0):.4f}
  SOMI held:      {balances.get('somi',  0):.4f}
  Total value:    ${balances.get('total', 0):.4f}

OPEN POSITIONS ({len(positions)}/3 max):
{chr(10).join(pos_lines) if pos_lines else '  None'}

ROUND-TRIP STATE:
{round_trip_hint}

PAIRS TO AVOID THIS TICK (recent failures):
{avoid_block}

LEADERBOARD:
  My rank:   #{lb.get('my_rank', '?')} of {lb.get('total', 10)}
  My fills:  {lb.get('my_tx', 0)}
  Signal:    {lb.get('signal', 'MAINTAIN')}

PER-PAIR NET PnL (last 24h, fills only):
{_pnl_lines(db_pnl) if db_pnl else '  no data yet'}

{last_trades_label}:
{chr(10).join(trade_lines) if trade_lines else '  None yet'}

Decide my next action. Obey the ROUND-TRIP STATE above first — that takes
precedence over every other heuristic.
"""


def _pnl_lines(pnl_by_pair: dict) -> str:
    if not pnl_by_pair:
        return "  none"
    out = []
    for pair, st in sorted(pnl_by_pair.items()):
        sign = "+" if st.get("net_usdso", 0) >= 0 else "-"
        out.append(f"  {pair:14} fills={st.get('fills',0):3}  net={sign}${abs(st.get('net_usdso',0)):.2f}")
    return chr(10).join(out)
