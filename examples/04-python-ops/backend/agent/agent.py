# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/agent/agent.py
import time, threading, json
from datetime import datetime
from config import (AGENT_LOOP_SECONDS, AGENT_STOP_BELOW,
                    AGENT_MIN_TRADE as _CFG_MIN, AGENT_MAX_TRADE as _CFG_MAX, AGENT_MAX_ORDERS,
                    MAX_CONCURRENT_POS)
from agent.brain     import decide
from agent.strategy  import PriceAnalyzer
from agent.state     import AgentState
from trading.dreamdex import DreamDEX
from monitor.leaderboard import LeaderboardMonitor
from monitor import db as agent_db


class TradingAgent:
    def __init__(self, portfolio=None, lb=None, dex=None,
                 name: str = "main",
                 min_trade: float | None = None,
                 max_trade: float | None = None,
                 loop_secs: int | None = None,
                 fixed_mode: str | None = None,
                 peer_agent: "TradingAgent | None" = None,
                 brainless: bool = False):
        """A trading agent loop.

        `dex` can be shared across multiple agents so they sit on the same
        SomniaWallet and its nonce lock — required for running two agents
        on the same EOA without race conditions.

        `fixed_mode` (e.g. "profit") pins this agent's brain mode so the
        global mode flag set by the dashboard doesn't change it. Used for
        the parallel micro-agent which always runs PROFIT-style.
        """
        self.name           = name
        self.analyzer       = PriceAnalyzer()
        self.state          = AgentState()
        # R9: parallel-agent support. Sharing one DreamDEX (and therefore one
        # SomniaWallet) means both agents serialise on the same nonce lock.
        self.dex            = dex if dex is not None else DreamDEX()
        # R6: re-use the running LeaderboardMonitor from main.py.
        self.lb             = lb if lb is not None else LeaderboardMonitor()
        self.portfolio      = portfolio  # C2: source of truth for capital-floor check
        self.running        = False
        self.paused         = False
        self.loop_secs      = loop_secs if loop_secs is not None else AGENT_LOOP_SECONDS
        self.max_orders     = AGENT_MAX_ORDERS   # 0 = unlimited
        self.min_trade      = min_trade if min_trade is not None else _CFG_MIN
        self.max_trade      = max_trade if max_trade is not None else _CFG_MAX
        self.fixed_mode     = fixed_mode  # None = follow global brain mode
        self.last_decision  = {}
        self.log_path       = f"logs/trades-{name}.jsonl"
        # When peer_agent is set, this agent owns the LLM call (via decide_pair)
        # and feeds the second decision to peer_agent.execute_external_decision.
        # When brainless=True, this agent has no _tick loop of its own — it
        # only executes decisions handed to it by another agent's orchestrator.
        self.peer_agent     = peer_agent
        self.brainless      = brainless

    # ── Prices feed subscriber ─────────────────────────────
    def on_price_update(self, pair: str, bid: float, ask: float):
        """Called by PriceFeed on every price update — feeds the analyzer."""
        self.analyzer.update(pair, bid, ask)

    # ── Public controls (Flask / ESP32) ───────────────────
    def start(self):
        self.running = True
        if self.brainless:
            print(f"[{self.name}] Started (brainless — driven by peer orchestrator)")
            return
        threading.Thread(target=self._loop, daemon=True).start()
        print(f"[{self.name}] Started")

    def execute_external_decision(self, decision: dict, prices: dict):
        """Entry point for the orchestrator to drive a peer (brainless)
        agent. Mirrors the same prep + execute flow _tick uses for its own
        decision, but skips the brain call."""
        if not decision or decision.get("action") not in ("buy", "sell"):
            # HOLD or empty → just stash it so /agent/{name} can show it
            decision = decision or {"action": "hold", "reason": "no decision"}
            decision["time"] = _now()
            self.last_decision = decision
            return
        decision["time"] = _now()
        self.last_decision = decision
        print(f"[{self.name}] 🧠 (orchestrated) {decision['action'].upper()} "
              f"| {decision.get('pair', '-')} "
              f"| ${decision.get('amount_usdso', 0):.2f} "
              f"| {decision.get('reason','')}")
        try:
            self._execute(decision, prices)
        except Exception as e:
            print(f"[{self.name}] external-decision execute failed: {e}")

    def pause(self):  self.paused = True
    def resume(self): self.paused = False

    # ── Live inventory read (used by the floor check) ─────────────────
    def _live_wallet_value(self, prices_unused=None):
        """Read live wallet USDso + per-pair base inventory via RPC. Returns
        (wallet_usdso, {pair: usd_value}). Read directly so the floor check
        sees the actual chain state, not the 60s-stale Portfolio cache."""
        try:
            from web3 import Web3
            from config import MARKETS, USDSO_ADDRESS
            w3 = self.dex.wallet.w3
            me = Web3.to_checksum_address(self.dex.wallet.address)
            erc20_abi = [{"name":"balanceOf","type":"function","stateMutability":"view",
                          "inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]
            usdso = Web3.to_checksum_address(USDSO_ADDRESS)
            wal_usdso = w3.eth.contract(address=usdso, abi=erc20_abi).functions.balanceOf(me).call() / 1e18
            prices = self.analyzer.get_snapshot()
            inv: dict[str, float] = {}
            for pair, mkt in MARKETS.items():
                mid = (prices.get(pair) or {}).get("mid") or 0
                if not mid:
                    continue
                if mkt.get("native"):
                    qty = w3.eth.get_balance(me) / 1e18
                    # Keep a small gas reserve — don't sell our last 2 SOMI.
                    sellable = max(0, qty - 2.0)
                    inv[pair] = sellable * mid
                    continue
                base = mkt.get("base")
                if not base or int(base, 16) == 0:
                    continue
                dec = int(mkt.get("baseDecimals", 18))
                try:
                    raw = w3.eth.contract(address=Web3.to_checksum_address(base), abi=erc20_abi).functions.balanceOf(me).call()
                    qty = raw / (10 ** dec)
                    inv[pair] = qty * mid
                except Exception:
                    inv[pair] = 0.0
            return wal_usdso, inv
        except Exception as e:
            print(f"[{self.name}] live_wallet_value failed: {e}")
            return None, {}

    def _liquidate_inventory(self, inventory: dict):
        """Sell ONE chunk of the biggest inventory position back to USDso.
        Capped at self.max_trade per call so a single fat IOC doesn't sim-
        revert when the book can't absorb it. Called from the floor-breach
        branch each tick — multi-tick drain instead of one-shot.

        Previous behaviour tried to sell the whole stack in a single IOC
        (e.g. 145 SOMI ~ $24) which the on-chain matching engine rejected
        every time, causing the floor breach to recur every tick while
        the inventory never actually decreased.
        """
        # Pick the single biggest position worth > $1.50. Sell only ONE
        # chunk this tick, capped at max_trade.
        big = [(p, usd) for p, usd in inventory.items() if usd >= 1.50]
        if not big:
            print(f"[{self.name}] 💸 no chunk worth liquidating (all < $1.50)")
            return
        big.sort(key=lambda kv: -kv[1])
        pair, usd = big[0]
        mid = (self.analyzer.get_snapshot().get(pair, {}) or {}).get("mid") or 0
        if not mid:
            print(f"[{self.name}] 💸 no price for {pair}, skip liquidation")
            return
        # One-shot chunk: min(inventory, max_trade). 0.97 multiplier to avoid
        # tripping minQty rounding.
        target_usd = min(self.max_trade, usd) * 0.97
        sell_qty = target_usd / mid
        try:
            print(f"[{self.name}] 💸 liquidating chunk: {pair} qty={sell_qty:.4f} (~${target_usd:.2f}, inventory total ${usd:.2f})")
            res = self.dex.place_order(
                symbol=pair, side="sell", qty=sell_qty, order_type="market",
            )
            print(f"[{self.name}] liquidation {pair}: {res.get('status','?')}")
        except Exception as e:
            print(f"[{self.name}] liquidation {pair} failed: {e}")

    def set_speed(self, speed: str):
        speeds = {"slow": 600, "normal": 300, "fast": 120, "max": 45}
        self.loop_secs = speeds.get(speed.lower(), 300)
        print(f"[{self.name}] Speed → {speed} ({self.loop_secs}s loop)")

    def set_max_orders(self, n: int):
        self.max_orders = max(0, int(n))
        print(f"[{self.name}] max_orders → {self.max_orders} (0 = unlimited)")

    def get_status(self) -> dict:
        tx = self.state.summary().get("tx_count", 0)
        remaining = max(0, self.max_orders - tx) if self.max_orders else None
        return {
            "running":         self.running,
            "paused":          self.paused,
            "loop_secs":       self.loop_secs,
            "last_decision":   self.last_decision,
            "state":           self.state.summary(),
            "max_orders":      self.max_orders,        # 0 = unlimited
            "orders_done":     tx,
            "orders_remaining": remaining,             # null = unlimited
        }

    # ── Internal loop ──────────────────────────────────────
    def _loop(self):
        while self.running:
            if not self.paused:
                try:
                    self._tick()
                except Exception as e:
                    print(f"[{self.name}] tick error: {e}")
            time.sleep(self.loop_secs)

    def _tick(self):
        # R5/R7: rank-based auto-flip — only runs when the user has opted in
        # via mode="auto" (AGENT_AUTO). Manual selection of grind or profit
        # is sticky: rank changes won't override it until the user explicitly
        # re-enables auto.
        try:
            from agent import brain as _brain
            # Agents with a fixed_mode skip the rank-based flip entirely.
            if self.fixed_mode is None and _brain.is_auto():
                lb_stats = self.lb.get_my_stats() if self.lb else {}
                current_mode = _brain.get_mode()
                rank = lb_stats.get("my_rank")
                if isinstance(rank, int):
                    if rank <= 2 and current_mode == "grind":
                        print(f"[{self.name}] 🎯 [auto] Rank ≤ 2 reached (#{rank}) — flip grind → profit")
                        _brain.set_mode_internal("profit")
                    elif rank > 2 and current_mode == "profit":
                        print(f"[{self.name}] 📉 [auto] Rank #{rank} outside top-2 — flip profit → grind")
                        _brain.set_mode_internal("grind")
        except Exception as e:
            print(f"[{self.name}] mode-flip check failed: {e}")

        # 0. Max-orders cap (0 = unlimited)
        tx_done = self.state.summary().get("tx_count", 0)
        if self.max_orders and tx_done >= self.max_orders:
            self.last_decision = {
                "action": "hold",
                "reason": f"max orders reached ({tx_done}/{self.max_orders})",
                "confidence": 100, "time": _now(),
            }
            return

        # 1. Capital-floor safety check. Reads a LIVE wallet USDso balance
        # via RPC instead of trusting the 60s-stale Portfolio cache (which
        # let us blow past $20 floor down to $8 in the last incident).
        # When the floor is breached, AUTO-LIQUIDATE wallet inventory (USDC.e,
        # WETH, WBTC, native SOMI down to a small gas reserve) back to USDso
        # before halting — that keeps trading sustainable instead of dead-
        # ending when round-trips accidentally accumulate base tokens.
        live_usdso, live_inventory = self._live_wallet_value(prices_unused=None)
        chain_usdso = live_usdso
        if chain_usdso is None and self.portfolio is not None:
            stats = self.portfolio.summary()
            chain_usdso = stats.get("agent_balance")
            last_ref = stats.get("last_refresh", 0)
            if last_ref and time.time() - last_ref > 120:
                print(f"[{self.name}] ⚠️  Portfolio stale ({int(time.time() - last_ref)}s) — holding")
                self.last_decision = {
                    "action": "hold", "reason": "portfolio stale",
                    "confidence": 100, "time": _now()
                }
                return
        balances = self.state.balances()
        usdso_for_floor = chain_usdso if chain_usdso is not None else balances["usdso"]
        if usdso_for_floor <= AGENT_STOP_BELOW:
            # Before halting: is there inventory to liquidate?
            inv_usd = sum(live_inventory.values()) if live_inventory else 0
            if inv_usd >= 2.0:
                print(f"[{self.name}] ⚠️  Wallet USDso ${usdso_for_floor:.2f} <= floor ${AGENT_STOP_BELOW:.2f} but ${inv_usd:.2f} of inventory exists — auto-liquidating before halt")
                try:
                    self._liquidate_inventory(live_inventory)
                except Exception as e:
                    print(f"[{self.name}] liquidation failed: {e}")
                self.last_decision = {
                    "action": "hold", "reason": f"auto-liquidated inventory (recovered ~${inv_usd:.2f})",
                    "confidence": 100, "time": _now()
                }
                return
            print(f"[{self.name}] ⚠️  USDso ${usdso_for_floor:.2f} <= floor ${AGENT_STOP_BELOW:.2f}, no inventory to liquidate — holding")
            self.last_decision = {
                "action": "hold", "reason": "capital floor hit (nothing to recover)",
                "confidence": 100, "time": _now()
            }
            return

        # 2. Current data
        prices    = self.analyzer.get_snapshot()
        positions = self.state.open_positions()
        lb_data   = self.lb.get_my_stats()

        if not prices:
            print(f"[{self.name}] No price data yet, skipping tick")
            return

        # Persist this tick's market state to sqlite so we can read it back
        # after container restarts and feed historical context to the brain.
        try:
            momentum_now = {
                p: ((pd.get("history", [])[-1]["mid"] - pd.get("history", [])[-6]["mid"]) /
                    pd.get("history", [])[-6]["mid"] * 100)
                if len(pd.get("history", [])) >= 6 else 0.0
                for p, pd in prices.items()
            }
            agent_db.record_tick(prices, momentum_now)
        except Exception as e:
            print(f"[{self.name}] tick persistence failed: {e}")

        # 3. Ask GPT — pass DB-backed history + per-pair PnL so the prompt
        # has cross-restart context.
        try:
            db_history = agent_db.last_trades(20, agent_name=self.name)
            db_pnl     = agent_db.pnl_by_pair(24)
        except Exception:
            db_history, db_pnl = [], {}

        if self.peer_agent is not None:
            # Plan-B orchestrator path: ONE LLM call returns decisions for
            # BOTH agents. Saves a call per cycle, lets the model coordinate
            # pair-selection and combined cash exposure.
            try:
                peer_history = agent_db.last_trades(20, agent_name=self.peer_agent.name)
            except Exception:
                peer_history = []
            from agent.brain import decide_pair
            paired = decide_pair(prices, balances,
                                 main_history=db_history,
                                 micro_history=peer_history,
                                 leaderboard=lb_data,
                                 db_pnl=db_pnl,
                                 main_mode_override=self.fixed_mode)
            decision = paired.get("main") or {"action": "hold", "reason": "orchestrator empty"}
            # Hand the peer its decision after our own _execute completes
            # (deferred so nonces serialise cleanly through one wallet lock).
            self._pending_peer_decision = paired.get("micro")
        else:
            decision = decide(prices, positions, balances,
                              self.state.history(), lb_data,
                              db_history=db_history, db_pnl=db_pnl,
                              mode_override=self.fixed_mode)
            self._pending_peer_decision = None
        decision["time"] = _now()

        # R8: in GRIND mode, refuse lazy HOLDs from the LLM. The only valid
        # reasons to HOLD are wallet < floor or every allowed pair failing
        # recently. The model otherwise hallucinates "waiting for next tick"
        # and idle-burns ticks that should be sending volume.
        try:
            from agent import brain as _brain
            effective_mode = self.fixed_mode or _brain.get_mode()
            if effective_mode == "grind" and decision.get("action") == "hold":
                wallet_usdso = (self.portfolio.summary().get("agent_balance", 0)
                                if self.portfolio else balances.get("usdso", 0))
                FAILS = {"would_revert","silent_reject","placed_unfilled","reverted","unverified"}
                by_pair = {}
                for t in db_history[:10]:
                    by_pair.setdefault(t.get("pair"), []).append(t.get("status",""))
                ALLOWED = ["SOMI:USDso", "USDC.e:USDso", "WETH:USDso"]
                playable = [
                    p for p in ALLOWED
                    if not (len(by_pair.get(p, [])) >= 2 and all(s in FAILS for s in by_pair[p][:3]))
                ]
                if wallet_usdso >= AGENT_STOP_BELOW and playable:
                    chosen = playable[0]
                    fallback_amt = round(min(self.max_trade, max(self.min_trade, self.max_trade)), 2)
                    print(f"[{self.name}] ⚠️  brain returned lazy HOLD; overriding → BUY {chosen} ${fallback_amt} (playable={playable})")
                    decision = {
                        "action": "buy", "pair": chosen, "amount_usdso": fallback_amt,
                        "order_type": "market", "limit_price": None,
                        "reason": f"override: lazy hold replaced ({chosen})",
                        "confidence": 80, "time": _now(),
                    }
        except Exception as e:
            print(f"[{self.name}] hold-override check failed: {e}")

        self.last_decision = decision
        print(f"[{self.name}] 🧠 {decision['action'].upper()} "
              f"| {decision.get('pair', '-')} "
              f"| conf={decision.get('confidence', 0)}% "
              f"| {decision.get('reason', '')}")

        # 4. Execute if not hold
        if decision["action"] in ("buy", "sell"):
            self._execute(decision, prices)

        # 5. Drive the peer agent (orchestrator path only). Sequential so
        # both txs serialise on the shared nonce lock cleanly — the wallet
        # already lines them up but doing it back-to-back keeps the order
        # deterministic.
        if self.peer_agent is not None and getattr(self, "_pending_peer_decision", None):
            peer_dec = self._pending_peer_decision
            self._pending_peer_decision = None
            try:
                self.peer_agent.execute_external_decision(peer_dec, prices)
            except Exception as e:
                print(f"[{self.name}] peer driver failed: {e}")

    def _execute(self, decision: dict, prices: dict):
        pair      = decision.get("pair")
        action    = decision.get("action")
        amt_usdso = float(decision.get("amount_usdso", self.min_trade))

        # C3: enforce MAX_CONCURRENT_POS in code (the LLM prompt alone isn't a guarantee).
        # Only blocks new BUYs — sells can always close positions.
        if action == "buy" and len(self.state.open_positions()) >= MAX_CONCURRENT_POS:
            print(f"[{self.name}] ⚠️  {len(self.state.open_positions())} positions open >= MAX_CONCURRENT_POS={MAX_CONCURRENT_POS} — skipping buy")
            return

        # Clamp to THIS agent's size range (main and micro have different bands).
        amt_usdso = max(self.min_trade, min(self.max_trade, amt_usdso))

        mid = prices.get(pair, {}).get("mid", 0)
        if not mid:
            print(f"[{self.name}] No price for {pair}, skipping")
            return

        from config import MARKETS
        mkt = MARKETS.get(pair)
        if not mkt:
            print(f"[{self.name}] Unknown pair {pair}")
            return

        # Convert USDso → base quantity
        qty = amt_usdso / mid

        # Snap to lot size (read from MARKETS — populated at boot from /v0/markets)
        try:
            lot     = float(mkt.get("lotSize", 0.0001))
            min_qty = float(mkt.get("minQuantity", 0.001))
            qty = round(round(qty / lot) * lot, 8)
            # M3: if bumping to min_qty would exceed AGENT_MAX_TRADE in USDso terms,
            # skip the trade rather than silently overshooting. e.g. WBTC minQty
            # costs ~$7.69 — if LLM said "$0.10 trade", we'd be 77× over.
            if qty < min_qty:
                min_qty_usdso = min_qty * mid
                if min_qty_usdso > self.max_trade:
                    print(f"[{self.name}] ⚠️  {pair} min qty {min_qty} costs ~${min_qty_usdso:.2f} > {self.name} max ${self.max_trade} — skipping")
                    return
                qty = min_qty
        except Exception as e:
            print(f"[{self.name}] Error snapping qty: {e}")

        # Determine funding source
        from config import AGENT_FUNDING_SOURCE
        funding = AGENT_FUNDING_SOURCE

        # Auto-fallback if gas is too low for vault operations
        if funding == "vault":
            try:
                native_bal = self.dex.wallet.native_balance()
                if native_bal < 0.05:
                    print(f"[{self.name}] ⚠️ Gas balance is low ({native_bal:.6f} STT). Falling back to wallet funding to save gas.")
                    funding = "wallet"
            except Exception as e:
                print(f"[{self.name}] Error checking gas balance: {e}")

        # Ensure sufficient funds in vault if using vault funding
        if funding == "vault":
            try:
                from web3 import Web3
                pool_addr = Web3.to_checksum_address(mkt["contract"])
                quote_addr = Web3.to_checksum_address(mkt["quote"])
                base_addr = Web3.to_checksum_address(mkt["base"])

                vault_abi = [
                    {"name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
                     "inputs": [{"name": "user", "type": "address"}, {"name": "token", "type": "address"}],
                     "outputs": [{"name": "", "type": "uint256"}]}
                ]
                pool = self.dex.wallet.w3.eth.contract(address=pool_addr, abi=vault_abi)

                if action == "buy":
                    # C5: size deposit at the SAME price the order will use (best ask + tick).
                    tick = float(mkt.get("tickSize", 0.0001))
                    book = self.dex.get_orderbook(pair)
                    best_ask = book.get("ask") or 0
                    raw_price = (best_ask + tick) if best_ask else (mid + tick)
                    limit_price = round(round(raw_price / tick) * tick, 6)

                    decimals = mkt["quoteDecimals"]
                    raw_needed = int(qty * limit_price * 1.02 * (10 ** decimals))
                    raw_bal = pool.functions.getWithdrawableBalance(self.dex.wallet.address, quote_addr).call()
                    if raw_bal < raw_needed:
                        # Affordability check: vault + wallet USDso must cover the deposit.
                        wallet_quote = self.dex.wallet.erc20_balance(mkt["quote"], decimals)
                        wallet_raw = int(wallet_quote * (10 ** decimals))
                        if raw_bal + wallet_raw < raw_needed:
                            affordable_qty = ((raw_bal + wallet_raw) / (10 ** decimals)) / (limit_price * 1.02)
                            affordable_qty = round(round(affordable_qty / lot) * lot, 8)
                            if affordable_qty < min_qty:
                                print(f"[{self.name}] ⚠️  BUY {pair} unaffordable: vault {raw_bal/(10**decimals):.4f} + wallet {wallet_quote:.4f} USDso < need {raw_needed/(10**decimals):.4f}. Skipping.")
                                result = {"status": "skipped", "reason": "insufficient quote (wallet+vault)"}
                                self._log({**decision, "qty": qty, "result": result, "mid": mid})
                                return
                            print(f"[{self.name}] ⚠️  Resizing BUY {pair} from {qty} → {affordable_qty} to match wallet+vault.")
                            qty = affordable_qty
                            raw_needed = int(qty * limit_price * 1.02 * (10 ** decimals))
                        deficit = round((raw_needed - raw_bal) / (10 ** decimals) * 1.01, 4)
                        print(f"[{self.name}] Vault deficit for buy (limit {limit_price}, 2% buf): {deficit} USDso. Depositing...")
                        self.dex.vault_deposit(pair, mkt["quote"], deficit)
                elif action == "sell":
                    decimals = mkt["baseDecimals"]
                    raw_needed = int(qty * (10 ** decimals))
                    raw_bal = pool.functions.getWithdrawableBalance(self.dex.wallet.address, base_addr).call()
                    if raw_bal < raw_needed:
                        # Affordability check for sells: vault base + wallet base must cover the deposit.
                        # For native pools (e.g. SOMI), wallet base = native_balance minus gas reserve.
                        if mkt.get("native"):
                            wallet_base = max(0.0, self.dex.wallet.native_balance() - 0.05)
                        else:
                            wallet_base = self.dex.wallet.erc20_balance(mkt["base"], decimals)
                        wallet_raw = int(wallet_base * (10 ** decimals))
                        if raw_bal + wallet_raw < raw_needed:
                            affordable_qty = (raw_bal + wallet_raw) / (10 ** decimals)
                            affordable_qty = round(round(affordable_qty / lot) * lot, 8)
                            if affordable_qty < min_qty:
                                print(f"[{self.name}] ⚠️  SELL {pair} unfundable: vault {raw_bal/(10**decimals):.6f} + wallet {wallet_base:.6f} base < need {raw_needed/(10**decimals):.6f}. Skipping (no SOMI to round-trip).")
                                result = {"status": "skipped", "reason": "no base inventory to sell"}
                                self._log({**decision, "qty": qty, "result": result, "mid": mid})
                                return
                            print(f"[{self.name}] ⚠️  Resizing SELL {pair} from {qty} → {affordable_qty} to match wallet+vault.")
                            qty = affordable_qty
                            raw_needed = int(qty * (10 ** decimals))
                        deficit = round((raw_needed - raw_bal) / (10 ** decimals) * 1.01, 8)
                        print(f"[{self.name}] Vault deficit for sell: {deficit} base. Depositing...")
                        self.dex.vault_deposit(pair, mkt["base"], deficit)
            except Exception as e:
                print(f"[{self.name}] Error checking/depositing to vault: {e}")
                result = {"status": "skipped", "reason": f"vault check failed: {e}"}
                self._log({**decision, "qty": qty, "result": result, "mid": mid})
                return

        # Submit via DreamDEX API
        result = self.dex.place_order(
            symbol      = pair,
            side        = action,
            qty         = qty,
            order_type  = decision.get("order_type", "market"),
            limit_price = decision.get("limit_price"),
            funding     = funding,
        )

        # Log
        log_entry = {**decision, "qty": qty, "result": result, "mid": mid}
        self._log(log_entry)
        # Expose the trade outcome on last_decision so the dashboard activity
        # log can distinguish on-chain success from sim-rejected attempts.
        self.last_decision["result_status"] = result.get("status")
        # Only mutate local state on vault-delta-PROVEN success. silent_reject,
        # unverified, reverted, error all skip — they either didn't move money
        # or can't be authoritatively confirmed.
        if result.get("status") == "success":
            self.state.record_trade(log_entry)
            # R4: drain quote vault back to wallet after every SELL.
            # The contest leaderboard counts wallet USDso only (not vault).
            # Without this drain each sell parks ~$2 in the vault and the agent
            # silently bleeds wallet runway despite "profitable" round-trips.
            if action == "sell":
                self._drain_quote_vault(pair)
        else:
            print(f"[{self.name}] Skipping state update — order result: {result.get('status')}")

    def _drain_quote_vault(self, pair: str, min_drain: float = 0.10):
        """Withdraw whatever USDso is sitting in the pool's quote vault back
        to the wallet. min_drain avoids wasting gas on dust."""
        try:
            from web3 import Web3
            from config import MARKETS, USDSO_ADDRESS
            mkt = MARKETS.get(pair)
            if not mkt:
                return
            pool_addr = Web3.to_checksum_address(mkt["contract"])
            quote_addr = Web3.to_checksum_address(mkt["quote"])
            abi = [{"name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
                    "inputs": [{"name": "u", "type": "address"}, {"name": "t", "type": "address"}],
                    "outputs": [{"name": "", "type": "uint256"}]}]
            pool = self.dex.wallet.w3.eth.contract(address=pool_addr, abi=abi)
            raw = pool.functions.getWithdrawableBalance(self.dex.wallet.address, quote_addr).call()
            human = raw / (10 ** int(mkt.get("quoteDecimals", 18)))
            if human < min_drain:
                return
            # withdraw 99.9% to avoid rounding-up issues
            amount = round(human * 0.999, 6)
            print(f"[{self.name}] 💸 Auto-drain {pair}: pulling ${amount:.4f} USDso vault → wallet")
            self.dex.vault_withdraw(pair, mkt["quote"], amount)
        except Exception as e:
            print(f"[{self.name}] auto-drain {pair} failed: {e}")

    def _log(self, entry: dict):
        import os
        os.makedirs("logs", exist_ok=True)
        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        # Mirror to sqlite. Tag with the agent's effective mode and name so
        # parallel agents stay distinguishable in the trade log.
        try:
            from agent import brain as _brain
            effective_mode = self.fixed_mode or _brain.get_mode()
            agent_db.record_trade(entry, mode=effective_mode, agent_name=self.name)
        except Exception as e:
            print(f"[{self.name}] db.record_trade failed: {e}")


def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")
