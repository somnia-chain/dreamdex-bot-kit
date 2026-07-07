#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Live trade monitor: shows balances only when a Buy/Sell happens.

Does not touch the running bot; tails bot.log and reads on-chain balances per trade.

Usage:
    source .venv/bin/activate && python bot/monitor.py
"""
import re
import sys
import time
from pathlib import Path

import yaml
from dotenv import load_dotenv

_repo_root = Path(__file__).resolve().parent.parent
load_dotenv(_repo_root / ".env")
sys.path.insert(0, str(_repo_root / "bot"))

from executor import LiveDreamDexBot  # noqa: E402
from web3 import Web3  # noqa: E402

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
GRAY = "\033[90m"
BOLD = "\033[1m"
RESET = "\033[0m"

ERC20_ABI = [
    {"constant": True, "inputs": [{"name": "_owner", "type": "address"}],
     "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}], "type": "function"},
]

MAKER_RE = re.compile(r"Maker (buy|sell) placed.*?tx=([0-9a-fA-Fx]+)")
SCALP_DONE_RE = re.compile(r"Scalp DONE .*?pnl=([+-][0-9.]+)")
SYM_RE = re.compile(r"(SOMI|WETH|WBTC):USDso")
QTY_RE = re.compile(r"qty=(\d+)")
USDSO_RE = re.compile(r"~\s*([0-9.]+)\s*USDso")
PRICE_RE = re.compile(r"@\s*([0-9.]+)")
PNLBPS_RE = re.compile(r"trade_pnl=([+-][0-9.]+)")
LOG_PATH = _repo_root / "logs" / "bot-forever.log"
if not LOG_PATH.exists():
    LOG_PATH = _repo_root / "bot.log"
BASELINE = 150.0  # overridden from config when present


def _sym_of(line: str) -> str:
    m = SYM_RE.search(line)
    return m.group(1) if m else "?"


def parse_trade_line(line: str) -> tuple[str | None, dict]:
    """Return (side, info) — side: buy | sell | done | None.

    info carries raw fields so the panel can show *what* was traded:
    {symbol, qty_raw, usdso, price, pnl, kind}
    """
    m = MAKER_RE.search(line)
    if m:
        return m.group(1).lower(), {"symbol": _sym_of(line), "kind": "maker"}

    if "Scalp DONE" in line:
        dm = SCALP_DONE_RE.search(line)
        return "done", {"symbol": _sym_of(line), "pnl": dm.group(1) if dm else None,
                        "kind": "done"}

    if re.search(r"Scalp (?:BUY(?:-[A-Z]+)?|BUY \[)", line):
        return "buy", _extract_amounts(line, "buy")

    if re.search(r"Scalp (?:SELL(?:-[A-Z]+)?|SELL \[|EXIT)", line):
        kind = "exit" if "EXIT" in line else "sell"
        return "sell", _extract_amounts(line, kind)

    return None, {}


def _extract_amounts(line: str, kind: str) -> dict:
    info: dict = {"symbol": _sym_of(line), "kind": kind}
    q = QTY_RE.search(line)
    if q:
        info["qty_raw"] = int(q.group(1))
    u = USDSO_RE.search(line)
    if u:
        info["usdso"] = float(u.group(1))
    p = PRICE_RE.search(line)
    if p:
        info["price"] = float(p.group(1))
    pn = PNLBPS_RE.search(line)
    if pn:
        info["pnl"] = pn.group(1)
    return info


def humanize(raw: int, decimals: int) -> float:
    return raw / (10 ** decimals)


class Monitor:
    def __init__(self):
        cfg = yaml.safe_load(open(_repo_root / "bot" / "config.yml"))
        self.cfg = cfg
        global BASELINE
        BASELINE = float(cfg.get("competition_initial_usdso", BASELINE))
        self.bot = LiveDreamDexBot(cfg)
        self.w3 = self.bot.web3
        self.addr = self.bot.address
        self.vault_enabled = bool(cfg.get("vault_enabled", False))
        self.vault_market = str(cfg.get("vault_market", "WETH:USDso"))
        self.quote = next(
            m.quote for m in self.bot.markets_registry.values()
            if m.quote_code.upper().startswith("USD")
        )
        self.quote_dec = next(iter(self.bot.markets_registry.values())).quote_decimals
        self.bases = {}
        self.dec_by_code = {}
        for sym, m in self.bot.markets_registry.items():
            self.bases[sym] = (m.base, m.base_decimals, m.base_is_native)
            self.dec_by_code[sym.split(":")[0]] = m.base_decimals
        self.prev = None

    def _describe(self, side: str, info: dict) -> str:
        """Human-readable 'what was traded' string from parsed log fields."""
        sym = info.get("symbol", "?")
        dec = self.dec_by_code.get(sym, 18)
        if info.get("kind") == "done":
            pnl = info.get("pnl")
            return f"{sym} round-trip" + (f"  pnl={pnl} USDso" if pnl else "")
        verb = "BUY" if side == "buy" else "SELL"
        parts = [verb, sym]
        if "qty_raw" in info:
            qty = info["qty_raw"] / (10 ** dec)
            parts.append(f"{qty:.6f}".rstrip("0").rstrip("."))
        if info.get("usdso") is not None:
            parts.append(f"(~${info['usdso']:.2f})")
        if info.get("price") is not None:
            parts.append(f"@ ${info['price']:,.4f}".rstrip("0").rstrip("."))
        if info.get("pnl") is not None and info.get("kind") == "exit":
            parts.append(f"pnl={info['pnl']} USDso")
        return " ".join(parts)

    def _erc20_balance(self, token: str, decimals: int) -> float:
        c = self.w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
        return humanize(c.functions.balanceOf(self.addr).call(), decimals)

    def _price(self, symbol: str) -> float:
        m = self.bot.markets_registry.get(symbol)
        if m is None:
            return 0.0
        bb, ba = self.bot._best_prices_for(m)
        if not bb or not ba:
            return 0.0
        if self.bot._spread_bps(bb, ba) > 200:
            return 0.0
        return float(bb + ba) / 2 / (10 ** m.quote_decimals)

    def _locked_in_orders(self, prices: dict) -> float:
        """USDso locked in open BUY orders + base locked in open SELL orders
        (valued at price). Invisible to balanceOf — must be counted or the
        portfolio appears to dip whenever an order is resting."""
        locked = 0.0
        for sym, m in self.bot.markets_registry.items():
            try:
                self.bot._set_active_market(sym)
                for o in self.bot._list_open_orders():
                    remaining = float(o.get("remaining") or o.get("amount") or 0)
                    if o.get("side") == "buy":
                        locked += remaining * float(o.get("price") or 0)
                    elif o.get("side") == "sell":
                        code = sym.split(":")[0]
                        locked += remaining * prices.get(code, 0.0)
            except Exception:
                continue
        return locked

    def _vault_rows(self, prices: dict) -> dict[str, float]:
        """Free vault balances (escrow in open orders counted separately)."""
        if not self.vault_enabled:
            return {}
        sym = self.vault_market
        if sym not in self.bot.markets_registry:
            return {}
        try:
            balances = self.bot._get_vault_balances(sym)
        except Exception:
            return {}
        m = self.bot.markets_registry[sym]
        rows: dict[str, float] = {}
        q = float(balances.get(m.quote_code, 0))
        if q > 1e-9:
            rows["Vault USDso"] = q
        b = float(balances.get(m.base_code, 0))
        if b > 1e-12:
            rows[f"Vault {m.base_code}"] = b
        return rows

    def snapshot(self) -> dict:
        usdso = humanize(self.bot._token_balance(self.quote), self.quote_dec)
        native = humanize(self.w3.eth.get_balance(self.addr), 18)
        rows = {"USDso": usdso, "SOMI(gas+inv)": native}
        prices = {}
        somi_px = (
            self._price("SOMI:USDso")
            if "SOMI:USDso" in self.bot.markets_registry
            else 0.0
        )
        prices["SOMI"] = somi_px
        seen = set()
        for sym, (tok, dec, is_native) in self.bases.items():
            if is_native or tok in seen:
                continue
            seen.add(tok)
            bal = self._erc20_balance(tok, dec)
            code = sym.split(":")[0]
            px = self._price(sym)
            prices[code] = px
            rows[code] = bal
        for label, amount in self._vault_rows(prices).items():
            rows[label] = amount
            if label == "Vault USDso":
                prices["Vault USDso"] = 1.0
            else:
                base_code = label.replace("Vault ", "")
                prices[base_code] = prices.get(base_code, self._price(self.vault_market))
        locked = self._locked_in_orders(prices)
        if locked > 0.01:
            rows["In orders (escrow)"] = locked
            prices["In orders (escrow)"] = 1.0
        # Match bot PnL: wallet + vault + open-order escrow + marked inventory.
        total = self.bot._portfolio_value_usdso_all() / (10 ** self.quote_dec)
        return {"rows": rows, "prices": prices, "total": total,
                "locked": locked, "ts": time.strftime("%H:%M:%S")}

    def _fmt_value(self, code: str, amount: float, px: float) -> str:
        if code in ("USDso",):
            return f"${amount:,.2f}"
        usd = amount * px
        return f"{amount:,.4f} (${usd:,.2f})"

    def print_panel(self, side: str, txt: str, snap: dict, prev: dict | None):
        if side == "done":
            color = CYAN
            label = "Round-trip"
        else:
            is_buy = side == "buy"
            color = GREEN if is_buy else RED
            label = "Buy" if is_buy else "Sell"
        total = snap["total"]
        pnl = total - BASELINE
        pnl_pct = (total / BASELINE - 1) * 100
        pnl_color = GREEN if pnl >= 0 else RED

        print(f"\n{color}{'─' * 64}{RESET}")
        print(f"{color}{BOLD}{label}{RESET}  {GRAY}{snap['ts']}{RESET}   {GRAY}{txt}{RESET}")

        somi_px = snap["prices"].get("SOMI", 0)
        line_parts = []
        for code, amount in snap["rows"].items():
            base_code = code.split("(")[0]
            if code == "Vault USDso":
                px = 1.0
            elif code.startswith("Vault "):
                px = snap["prices"].get(code.replace("Vault ", ""), 0)
            elif code == "In orders (escrow)":
                px = 1.0
            else:
                px = somi_px if base_code == "SOMI" else snap["prices"].get(base_code, 0)
            val = self._fmt_value(
                "USDso" if code in ("USDso", "Vault USDso", "In orders (escrow)") else base_code.replace("Vault ", ""),
                amount, px,
            )
            delta_str = ""
            if prev:
                d = amount - prev["rows"].get(code, amount)
                if abs(d) > 1e-9:
                    dc = GREEN if d > 0 else RED
                    delta_str = f" {dc}({d:+,.4f}){RESET}"
            line_parts.append(f"{CYAN}{code}{RESET} {val}{delta_str}")
        print("   " + "  |  ".join(line_parts))

        chg = ""
        if prev:
            d = total - prev["total"]
            dc = GREEN if d >= 0 else RED
            chg = f"  {dc}({d:+,.2f}){RESET}"
        locked = snap.get("locked", 0.0)
        locked_str = f"  {GRAY}(in-orders ${locked:,.2f}){RESET}" if locked > 0.01 else ""
        print(f"   {BOLD}Portfolio:{RESET} ${total:,.2f}{chg}{locked_str}   "
              f"{BOLD}PnL:{RESET} {pnl_color}{pnl:+,.2f} ({pnl_pct:+.1f}%){RESET}")
        print(f"{color}{'─' * 64}{RESET}")

    def run(self):
        print(f"{BOLD}{CYAN}DreamDEX Monitor — updates on Buy/Sell only{RESET}")
        print(f"{GRAY}Wallet: {self.addr}{RESET}")
        snap = self.snapshot()
        self.prev = snap
        pnl = snap["total"] - BASELINE
        pc = GREEN if pnl >= 0 else RED
        print(f"{GRAY}Starting portfolio: ${snap['total']:,.2f}  "
              f"PnL: {pc}{pnl:+,.2f}{RESET}{GRAY}  ({snap['ts']}){RESET}")
        print(f"{GRAY}Waiting for trades...{RESET}\n")

        if not LOG_PATH.exists():
            print(f"{RED}bot.log not found: {LOG_PATH}{RESET}")
            return
        with open(LOG_PATH, "r") as f:
            f.seek(0, 2)
            while True:
                line = f.readline()
                if not line:
                    time.sleep(0.5)
                    continue
                side, info = parse_trade_line(line)
                if side is None:
                    r = re.search(r"Partial rebalance drift=\d+bps side=(buy|sell)", line)
                    if r:
                        side = r.group(1)
                        info = {"symbol": _sym_of(line), "kind": "rebalance"}
                if side is None:
                    continue
                try:
                    txt = self._describe(side, info)
                    snap = self.snapshot()
                    self.print_panel(side, txt, snap, self.prev)
                    self.prev = snap
                except Exception as exc:
                    print(f"{YELLOW}(balance read failed: {exc}){RESET}")


if __name__ == "__main__":
    try:
        Monitor().run()
    except KeyboardInterrupt:
        print("\nMonitor stopped.")
