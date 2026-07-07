# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""SQLite-backed memory for the agent.

Persists two things across container restarts:
  1. Every trade attempt + result (so brain history isn't wiped on rebuild)
  2. Every market tick snapshot (price + momentum) for trend awareness

Stored at /app/data/agent.db inside the container; the docker-compose
volume mount keeps it on the host. Single-process access so no locking
worries — sqlite's default mode is fine.

Read side is exposed as cheap helper queries (last_trades, recent_ticks,
pnl_by_pair) for the brain prompt and the /agent/stats endpoint.
"""
from __future__ import annotations
import os
import sqlite3
import threading
import time
from typing import Iterable

_DB_PATH = os.environ.get("AGENT_DB_PATH", "/app/data/agent.db")
_LOCK = threading.Lock()


def _conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    c = sqlite3.connect(_DB_PATH, timeout=5.0, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def init():
    """Create tables if missing + add any new columns on existing DBs.

    Order matters: tables first, then a column-existence check that adds
    `agent_name` on older DBs, then indexes (which reference that column).
    Doing the index in the initial CREATE script would crash before the
    migration ran on pre-`agent_name` databases.
    """
    with _LOCK, _conn() as c:
        # 1) Tables — create if absent. Includes agent_name for fresh DBs.
        c.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                ts           REAL    NOT NULL,
                action       TEXT    NOT NULL,
                pair         TEXT,
                qty          REAL,
                amount_usdso REAL,
                price        REAL,
                status       TEXT,
                tx_hash      TEXT,
                vault_delta  TEXT,
                reason       TEXT,
                confidence   INTEGER,
                mode         TEXT,
                agent_name   TEXT DEFAULT 'main'
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS market_ticks (
                ts          REAL    NOT NULL,
                pair        TEXT    NOT NULL,
                mid         REAL,
                bid         REAL,
                ask         REAL,
                momentum_30m REAL,
                PRIMARY KEY (ts, pair)
            )
        """)

        # 2) Migration — add agent_name to pre-existing tables.
        try:
            cols = {row[1] for row in c.execute("PRAGMA table_info(trades)").fetchall()}
            if "agent_name" not in cols:
                c.execute("ALTER TABLE trades ADD COLUMN agent_name TEXT DEFAULT 'main'")
                print("[db] migrated trades table: added agent_name column")
        except Exception as e:
            print(f"[db] agent_name migration failed: {e}")

        # 3) Indexes — safe now that agent_name exists.
        c.execute("CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_trades_pair_status ON trades(pair, status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_name)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ticks_pair_ts ON market_ticks(pair, ts)")


# ── Writes ────────────────────────────────────────────────────────────

def record_trade(entry: dict, mode: str = "grind", agent_name: str = "main") -> None:
    """Called from agent._execute on every trade attempt (success or skip).
    `entry` is the same log_entry the agent already builds.
    `agent_name` lets parallel agents (main, micro, manual) keep their rows
    distinguishable for per-agent stats and per-agent history feedback."""
    res = entry.get("result", {}) or {}
    try:
        with _LOCK, _conn() as c:
            c.execute(
                """INSERT INTO trades
                   (ts, action, pair, qty, amount_usdso, price, status, tx_hash,
                    vault_delta, reason, confidence, mode, agent_name)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    time.time(),
                    entry.get("action", ""),
                    entry.get("pair"),
                    float(entry.get("qty") or 0),
                    float(entry.get("amount_usdso") or 0),
                    float(entry.get("mid") or 0),
                    res.get("status", ""),
                    res.get("tx_hash"),
                    res.get("vault_delta"),
                    entry.get("reason"),
                    int(entry.get("confidence") or 0),
                    mode,
                    agent_name,
                ),
            )
    except Exception as e:
        print(f"[db] record_trade failed: {e}")


def record_trades_batch(entries: list, mode: str = "grind", agent_name: str = "main") -> int:
    """Insert many trade entries in a single transaction. Used by the burst's
    async logger thread so the hot path never blocks on per-row writes.
    Returns the number of rows written."""
    if not entries:
        return 0
    rows = []
    for entry in entries:
        res = entry.get("result", {}) or {}
        rows.append((
            time.time(),
            entry.get("action", ""),
            entry.get("pair"),
            float(entry.get("qty") or 0),
            float(entry.get("amount_usdso") or 0),
            float(entry.get("mid") or 0),
            res.get("status", ""),
            res.get("tx_hash"),
            res.get("vault_delta"),
            entry.get("reason"),
            int(entry.get("confidence") or 0),
            mode,
            agent_name,
        ))
    try:
        with _LOCK, _conn() as c:
            c.executemany(
                """INSERT INTO trades
                   (ts, action, pair, qty, amount_usdso, price, status, tx_hash,
                    vault_delta, reason, confidence, mode, agent_name)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                rows,
            )
        return len(rows)
    except Exception as e:
        print(f"[db] record_trades_batch failed: {e}")
        return 0


def set_status_by_hash(tx_hash: str, status: str) -> None:
    """Reconcile a previously-logged tx's status (sent → confirmed/reverted)
    once its receipt is known. Used by the burst's end-of-run receipt sweep."""
    if not tx_hash:
        return
    try:
        with _LOCK, _conn() as c:
            c.execute("UPDATE trades SET status=? WHERE tx_hash=?", (status, tx_hash))
    except Exception as e:
        print(f"[db] set_status_by_hash failed: {e}")


def record_tick(prices: dict, momentum: dict) -> None:
    """Snapshot all pair prices + 30-min momentum once per agent tick.
    Skipped silently if prices is empty (boot)."""
    if not prices:
        return
    now = time.time()
    try:
        with _LOCK, _conn() as c:
            for pair, p in prices.items():
                c.execute(
                    """INSERT OR REPLACE INTO market_ticks
                       (ts, pair, mid, bid, ask, momentum_30m)
                       VALUES (?,?,?,?,?,?)""",
                    (
                        now, pair,
                        float(p.get("mid") or 0),
                        float(p.get("bid") or 0),
                        float(p.get("ask") or 0),
                        float(momentum.get(pair) or 0),
                    ),
                )
    except Exception as e:
        print(f"[db] record_tick failed: {e}")


# ── Reads (used by brain prompt + /agent/stats) ────────────────────────

def last_trades(limit: int = 20, agent_name: str | None = None) -> list[dict]:
    """Newest-first trade rows. When agent_name is set, filter to that
    agent only — each parallel agent reads its own history so the
    brain's round-trip rule doesn't cross-contaminate."""
    try:
        with _LOCK, _conn() as c:
            if agent_name:
                rows = c.execute(
                    """SELECT ts, action, pair, qty, amount_usdso, price, status,
                              reason, confidence, mode, agent_name
                       FROM trades WHERE agent_name = ? ORDER BY id DESC LIMIT ?""",
                    (agent_name, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    """SELECT ts, action, pair, qty, amount_usdso, price, status,
                              reason, confidence, mode, agent_name
                       FROM trades ORDER BY id DESC LIMIT ?""",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
    except Exception as e:
        print(f"[db] last_trades failed: {e}")
        return []


def fill_stats(since_hours: int = 2, agent_name: str | None = None) -> dict:
    """Empirical fill rates and net PnL per (pair, size_bucket) over the
    recent window. The brain consumes this to learn — from real chain
    behaviour — which (pair, size) combinations actually fill.

    Returns:
      {
        "SOMI:USDso": [
          {"size": "$1-3",  "attempts": 12, "fills": 11, "rate": 0.92, "net": +0.08},
          {"size": "$3-6",  "attempts": 28, "fills": 22, "rate": 0.79, "net": +1.20},
          {"size": "$6-10", "attempts": 45, "fills": 27, "rate": 0.60, "net": -0.40},
          {"size": "$10+",  "attempts": 30, "fills": 13, "rate": 0.43, "net": -0.85},
        ],
        ...
      }
    """
    since = time.time() - since_hours * 3600
    buckets = [
        (0,    3,   "$1-3"),
        (3,    6,   "$3-6"),
        (6,    10,  "$6-10"),
        (10,   16,  "$10-16"),
        (16,   1e9, "$16+"),
    ]
    out: dict[str, list[dict]] = {}
    try:
        with _LOCK, _conn() as c:
            where_agent = ""
            params: list = [since]
            if agent_name:
                where_agent = " AND agent_name = ?"
                params.append(agent_name)
            for lo, hi, label in buckets:
                rows = c.execute(
                    f"""SELECT pair, action,
                              COUNT(*) AS attempts,
                              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS fills,
                              SUM(CASE WHEN status='success' AND action='buy'  THEN -amount_usdso ELSE 0 END) AS spent,
                              SUM(CASE WHEN status='success' AND action='sell' THEN  amount_usdso ELSE 0 END) AS earned
                       FROM trades
                       WHERE ts > ? {where_agent} AND amount_usdso >= ? AND amount_usdso < ? AND pair IS NOT NULL
                       GROUP BY pair""",
                    tuple(params) + (lo, hi),
                ).fetchall()
                for r in rows:
                    pair = r["pair"]
                    out.setdefault(pair, [])
                    attempts = int(r["attempts"] or 0)
                    fills    = int(r["fills"]    or 0)
                    net      = float((r["spent"] or 0) + (r["earned"] or 0))
                    if attempts == 0:
                        continue
                    out[pair].append({
                        "size": label,
                        "attempts": attempts,
                        "fills": fills,
                        "rate": round(fills / attempts, 2),
                        "net":  round(net, 2),
                    })
    except Exception as e:
        print(f"[db] fill_stats failed: {e}")
    return out


def consecutive_fail_streak(pair: str, agent_name: str | None = None, limit: int = 20) -> int:
    """How many of the most-recent N trades for this pair were failures
    (no successes in between). Used by the avoid-list to flag pairs only
    when failures are PERSISTENT, not transient."""
    FAILS = {"would_revert", "silent_reject", "placed_unfilled", "reverted", "unverified", "error"}
    try:
        with _LOCK, _conn() as c:
            if agent_name:
                rows = c.execute(
                    """SELECT status FROM trades
                       WHERE pair = ? AND agent_name = ?
                       ORDER BY id DESC LIMIT ?""",
                    (pair, agent_name, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    """SELECT status FROM trades
                       WHERE pair = ? ORDER BY id DESC LIMIT ?""",
                    (pair, limit),
                ).fetchall()
            streak = 0
            for r in rows:
                if (r["status"] or "") in FAILS:
                    streak += 1
                else:
                    break
            return streak
    except Exception as e:
        print(f"[db] consecutive_fail_streak failed: {e}")
        return 0


def pnl_by_pair(since_hours: int = 24) -> dict:
    """Approximate per-pair net USDso change.
    BUYs subtract amount_usdso, SELLs add it. Only counts status=success."""
    since = time.time() - since_hours * 3600
    out: dict[str, dict] = {}
    try:
        with _LOCK, _conn() as c:
            rows = c.execute(
                """SELECT pair,
                          SUM(CASE WHEN action='buy'  THEN -amount_usdso ELSE 0 END) AS spent,
                          SUM(CASE WHEN action='sell' THEN  amount_usdso ELSE 0 END) AS earned,
                          COUNT(*) AS fills
                   FROM trades
                   WHERE status='success' AND ts > ? AND pair IS NOT NULL
                   GROUP BY pair""",
                (since,),
            ).fetchall()
            for r in rows:
                net = (r["spent"] or 0) + (r["earned"] or 0)
                out[r["pair"]] = {
                    "net_usdso": round(net, 4),
                    "fills":     int(r["fills"]),
                }
    except Exception as e:
        print(f"[db] pnl_by_pair failed: {e}")
    return out


def recent_ticks(pair: str, n: int = 12) -> list[dict]:
    try:
        with _LOCK, _conn() as c:
            rows = c.execute(
                """SELECT ts, mid, momentum_30m FROM market_ticks
                   WHERE pair = ? ORDER BY ts DESC LIMIT ?""",
                (pair, n),
            ).fetchall()
            return list(reversed([dict(r) for r in rows]))
    except Exception as e:
        print(f"[db] recent_ticks failed: {e}")
        return []


def stats_summary() -> dict:
    """Used by /agent/stats — totals + last-N trade window."""
    try:
        with _LOCK, _conn() as c:
            totals = c.execute(
                """SELECT
                     COUNT(*)                                              AS attempts,
                     SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)     AS fills,
                     SUM(CASE WHEN status='placed_unfilled' THEN 1 ELSE 0 END) AS unfilled,
                     SUM(CASE WHEN status='silent_reject' THEN 1 ELSE 0 END)   AS rejects
                   FROM trades"""
            ).fetchone()
            return {
                "trade_attempts": int(totals["attempts"] or 0),
                "fills":          int(totals["fills"] or 0),
                "placed_unfilled": int(totals["unfilled"] or 0),
                "silent_rejects": int(totals["rejects"] or 0),
                "pnl_by_pair_24h": pnl_by_pair(24),
                "last_20_trades":  last_trades(20),
            }
    except Exception as e:
        print(f"[db] stats_summary failed: {e}")
        return {"error": str(e)}
