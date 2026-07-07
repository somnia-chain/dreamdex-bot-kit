# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/monitor/leaderboard.py
"""Polls the dreamDEX mainnet leaderboard for the competition wallet.

The leaderboard is mainnet-only — even when the bot is running on testnet,
we look up the MAINNET competition address so the watch can show our
ranking the moment Vercel deploys the leaderboard."""
import time
import threading
import requests
from config import LEADERBOARD_URL, LEADERBOARD_ADDRESS, LEADERBOARD_POLL

class LeaderboardMonitor:
    def __init__(self):
        self.stats = {
            "my_rank":  "?",
            "total":    0,
            "my_tx":    0,
            "third_tx": 0,
            "gap":      0,
            "signal":   "MAINTAIN",
            "address":  LEADERBOARD_ADDRESS,
            "live":     False,  # flips True after first successful fetch
        }
        self.running = False

    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        print(f"[LeaderboardMonitor] Polling {LEADERBOARD_URL} for {LEADERBOARD_ADDRESS}")

    def _loop(self):
        while self.running:
            self._fetch()
            time.sleep(LEADERBOARD_POLL)

    def _fetch(self):
        try:
            resp = requests.get(LEADERBOARD_URL, timeout=5)
            if resp.status_code != 200:
                # Vercel returns plaintext "DEPLOYMENT_NOT_FOUND" until launch.
                print(f"[LeaderboardMonitor] HTTP {resp.status_code} — {resp.text[:80]}")
                return
            try:
                data = resp.json()
            except ValueError:
                print(f"[LeaderboardMonitor] non-JSON body — leaderboard likely not live yet")
                return

            # Tolerate a few common shapes:
            #   [{"address","tx_count"}, ...]
            #   {"leaderboard":[...]}
            #   {"entries":[...]}  /  {"data":[...]}
            #   {"traders":[...]}  ← real shape from
            #     https://dreamdex-leaderboard-super-cool.vercel.app/api/leaderboard
            lb = data
            if isinstance(data, dict):
                for key in ("traders", "leaderboard", "entries", "data", "results"):
                    if key in data and isinstance(data[key], list):
                        lb = data[key]; break
            if not isinstance(lb, list):
                print(f"[LeaderboardMonitor] unexpected shape: {type(data).__name__}")
                return

            # Normalize tx-count field name across possible API revisions
            def tx_of(e):
                for k in ("tx_count", "txCount", "transactions", "txs", "count"):
                    if k in e:
                        try: return int(e[k])
                        except (TypeError, ValueError): pass
                return 0

            lb = sorted(lb, key=tx_of, reverse=True)
            total = len(lb)
            my_rank = "?"
            my_tx = 0
            my_fills = 0
            my_vol = 0.0
            my_pnl = 0.0
            my_bal = 0.0
            target = LEADERBOARD_ADDRESS.lower()
            for idx, entry in enumerate(lb):
                if str(entry.get("address", "")).lower() == target:
                    my_rank  = idx + 1
                    my_tx    = tx_of(entry)
                    my_fills = int(entry.get("fills", 0) or 0)
                    try: my_vol = float(entry.get("volumeUsdso") or entry.get("volume") or 0)
                    except (TypeError, ValueError): my_vol = 0.0
                    try: my_pnl = float(entry.get("pnl") or 0)
                    except (TypeError, ValueError): my_pnl = 0.0
                    try: my_bal = float(entry.get("usdsoBalance") or 0)
                    except (TypeError, ValueError): my_bal = 0.0
                    break

            third_tx = tx_of(lb[2]) if total >= 3 else (tx_of(lb[-1]) if total else 0)
            gap = my_tx - third_tx

            # Signal logic: outside top-3 = push; in top-3 with safe gap = coast
            if my_rank == "?" or (isinstance(my_rank, int) and my_rank > 3):
                signal = "ACCELERATE"
            elif gap > 50:
                signal = "SLOW DOWN"
            elif gap > 20:
                signal = "MAINTAIN"
            else:
                signal = "ACCELERATE"

            self.stats = {
                "my_rank":   my_rank,
                "total":     total,
                "my_tx":     my_tx,
                "my_fills":  my_fills,
                "my_volume": my_vol,
                "my_pnl":    my_pnl,
                "my_balance": my_bal,
                "third_tx":  third_tx,
                "gap":       gap,
                "signal":    signal,
                "address":   LEADERBOARD_ADDRESS,
                "live":      True,
            }
        except Exception as e:
            print(f"[LeaderboardMonitor] fetch error: {e}")

    def get_my_stats(self) -> dict:
        return self.stats
