#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
profit_maker.py — NO-BLEED PostOnly maker for USDC.e:USDso on Wallet P.

This is the contest's profit lane. It runs on the dedicated profit wallet (P),
NEVER on the leaderboard/burst wallet (H). Its one job is to capture spread
without ever realizing a loss. It is allowed to sit idle indefinitely.

HARD NO-BLEED INVARIANTS (enforced in code, not just intent):
  1. PostOnly only. Never IOC / market. Orders only ever JOIN the book.
  2. BUY price = best bid (never crosses the ask).
  3. SELL price = max(best ask, buy_price + MARGIN_TICKS*tick). NEVER below
     buy+margin — so every SELL fill clears gas and books a profit. If the
     market never reaches that price, we HOLD the inventory forever. No
     stop-loss, ever.
  4. Low churn: an unfilled order is left to SIT. We only cancel+re-quote when
     it has been resting > REQUOTE_S AND the book has drifted > DRIFT_TICKS away
     from our price. This bounds gas burned on re-quoting (the only bleed
     vector for a PostOnly maker).
  5. Gas-reserve floor: never place a tx if Wallet P's native SOMI < the
     reserve. Below that, HOLD until topped up.
  6. Capital firewall: only ever touches Wallet P's funds (its own address +
     vault). It cannot reach Wallet H.

Pair is hard-locked to USDC.e:USDso (ERC20 base — native SOMI maker SELL is
impossible on dreamDEX; see project lessons).

Usage:
  python3 profit_maker.py --smoke   # deposit check + one resting BUY then cancel
  python3 profit_maker.py           # full loop
"""
import os
import sys
import time
import json
import signal
import argparse

sys.path.insert(0, "/app")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PAIR = os.environ.get("PROFIT_PAIR", "WETH:USDso")  # devs banned the stablecoin pair

# ── Config (env-overridable) ───────────────────────────────────────────────
KEY          = os.environ.get("PROFIT_PRIVATE_KEY")
ADDR         = os.environ.get("PROFIT_ADDRESS")
LEG_USD      = float(os.environ.get("PROFIT_LEG_USD", "10.0"))
MARGIN_TICKS = int(os.environ.get("PROFIT_MARGIN_TICKS", "3"))   # SELL ≥ buy + this; clears gas
REQUOTE_S    = int(os.environ.get("PROFIT_REQUOTE_S", "1800"))   # let orders sit this long before considering a re-quote
DRIFT_TICKS  = int(os.environ.get("PROFIT_DRIFT_TICKS", "5"))    # only re-quote if book moved this far from our price
GAS_RESERVE  = float(os.environ.get("PROFIT_GAS_RESERVE_SOMI", "0.3"))
FUNDING      = os.environ.get("PROFIT_FUNDING", "wallet")  # wallet|vault; wallet avoids the vault-inventory wedge (buy fill lands in wallet, so sell must read wallet too)
MAX_LOSS     = float(os.environ.get("PROFIT_MAX_LOSS", "0.10"))  # hard backstop; should never trip
POLL_S       = float(os.environ.get("PROFIT_POLL_S", "10"))
STATS_PATH   = os.environ.get("PROFIT_STATS_PATH", "/tmp/profit_maker_stats.json")
PIDFILE      = "/tmp/profit_maker.pid"

if not KEY or not ADDR:
    raise SystemExit("set PROFIT_PRIVATE_KEY and PROFIT_ADDRESS in env")

from web3 import Web3
from config import MARKETS, SOMNIA_RPC
from trading.dreamdex import DreamDEX

ADDR = Web3.to_checksum_address(ADDR)

_ERC20_ABI = [{"name": "balanceOf", "type": "function", "stateMutability": "view",
               "inputs": [{"name": "a", "type": "address"}],
               "outputs": [{"name": "", "type": "uint256"}]}]
_WB_ABI = [{"name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
            "inputs": [{"name": "u", "type": "address"}, {"name": "t", "type": "address"}],
            "outputs": [{"name": "", "type": "uint256"}]}]
_POOLPARAMS_ABI = [{"inputs": [], "name": "getPoolParams", "outputs": [
    {"name": "baseToken", "type": "address"}, {"name": "quoteToken", "type": "address"},
    {"name": "makerFeeBpsTimes1k", "type": "uint256"}, {"name": "takerFeeBpsTimes1k", "type": "uint256"},
    {"name": "tickSize", "type": "uint256"}, {"name": "minQuantity", "type": "uint256"},
    {"name": "lotSize", "type": "uint256"}], "stateMutability": "view", "type": "function"}]

_stats = {
    "wallet": ADDR, "pair": PAIR, "state": "flat",
    "rounds": 0, "fills": 0, "realized_pnl": 0.0,
    "open_order_id": None, "resting_px": None, "last_action": "init",
    "last_action_ts": time.time(), "errors": 0,
}


def _log(m): print(f"[profit {time.strftime('%H:%M:%S')}] {m}", flush=True)


def _write_stats():
    try:
        with open(STATS_PATH + ".tmp", "w") as f:
            json.dump(_stats, f)
        os.replace(STATS_PATH + ".tmp", STATS_PATH)
    except Exception as e:
        _log(f"stats write err: {e}")


# ── Singleton guard ─────────────────────────────────────────────────────────
def _acquire_pid():
    try:
        fd = os.open(PIDFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        os.write(fd, str(os.getpid()).encode()); os.close(fd); return
    except FileExistsError:
        pass
    try:
        old = int(open(PIDFILE).read().strip())
        os.kill(old, 0)
        cl = open(f"/proc/{old}/cmdline", "rb").read().replace(b"\x00", b" ").decode("replace")
        if "profit_maker" in cl:
            _log(f"already running (pid {old}) — exiting."); sys.exit(0)
    except (ProcessLookupError, PermissionError, OSError, ValueError):
        pass
    open(PIDFILE, "w").write(str(os.getpid()))


def _release_pid():
    try: os.remove(PIDFILE)
    except FileNotFoundError: pass


# ── Market params + balances ────────────────────────────────────────────────
def _mkt():
    m = MARKETS[PAIR]
    return (Web3.to_checksum_address(m["contract"]),
            Web3.to_checksum_address(m["base"]),
            Web3.to_checksum_address(m["quote"]),
            int(m.get("baseDecimals", 6)), int(m.get("quoteDecimals", 18)))


def _balances(w3):
    pool, base, quote, bd, qd = _mkt()
    bt = w3.eth.contract(address=base, abi=_ERC20_ABI)
    qt = w3.eth.contract(address=quote, abi=_ERC20_ABI)
    pc = w3.eth.contract(address=pool, abi=_WB_ABI)
    w_base = bt.functions.balanceOf(ADDR).call() / 10**bd
    w_quote = qt.functions.balanceOf(ADDR).call() / 10**qd
    v_base = pc.functions.getWithdrawableBalance(ADDR, base).call() / 10**bd
    v_quote = pc.functions.getWithdrawableBalance(ADDR, quote).call() / 10**qd
    return {
        "base": w_base + v_base, "quote": w_quote + v_quote,
        "w_quote": w_quote, "v_quote": v_quote, "w_base": w_base, "v_base": v_base,
        "somi": w3.eth.get_balance(ADDR) / 1e18,
    }


def _pool_params(w3):
    """Fetch real tick/lot/minQty from the pool (human units). The MARKETS dict
    has no tick/lot/minQty, and they differ per pair — never hard-code them."""
    pool, base, quote, bd, qd = _mkt()
    p = w3.eth.contract(address=pool, abi=_POOLPARAMS_ABI).functions.getPoolParams().call()
    tick = p[4] / 10**qd
    minq = p[5] / 10**bd
    lot  = p[6] / 10**bd
    return tick, lot, minq


def _snap(px, tick):
    dec = len(f"{tick:.10f}".rstrip("0").split(".")[1])
    return round(round(px / tick) * tick, dec)


def _open_oid(dex):
    try:
        o = dex.get_open_orders(PAIR)
        if o:
            return str(o[0].get("id") or o[0].get("orderId") or o[0].get("order_id") or "")
    except Exception as e:
        _log(f"get_open_orders err: {e}")
    return None


def _cancel(dex):
    oid = _open_oid(dex)
    if not oid:
        return True
    _log(f"cancel order {oid}")
    r = dex.cancel_order(PAIR, oid)
    _stats["open_order_id"] = None; _stats["resting_px"] = None; _write_stats()
    return r.get("status") == "cancelled"


def _ensure_vault_usdso(dex, w3, need):
    """Make sure Wallet P has >= `need` USDso in the vault for a BUY. Deposits
    from wallet if short (keeps SOMI for gas; USDso isn't a gas token)."""
    b = _balances(w3)
    if b["v_quote"] >= need:
        return True
    short = need - b["v_quote"]
    if b["w_quote"] < short:
        _log(f"cannot fund vault: need {short:.2f} USDso, wallet has {b['w_quote']:.2f}")
        return False
    _, _, quote, _, _ = _mkt()
    _log(f"depositing {short:.2f} USDso to vault ...")
    dex.vault_deposit(PAIR, quote, round(short + 0.01, 2))
    time.sleep(3)
    return True


# ── Fill wait with sit-and-drift re-quote decision ──────────────────────────
def _wait(dex, w3, side, bal0, resting_px, tick):
    """Poll for a fill. Returns 'filled', or 'requote' when the order has sat
    past REQUOTE_S AND the book has drifted > DRIFT_TICKS from our price, or
    'gas' if SOMI fell below reserve, or 'cap'/'error'."""
    placed = time.time(); errs = 0
    while True:
        time.sleep(POLL_S)
        try:
            b = _balances(w3)
        except Exception as e:
            errs += 1; _log(f"poll err ({errs}): {e}")
            if errs >= 5: return "error"
            continue
        errs = 0
        # Heartbeat: a successful poll means the loop is healthy (just waiting to
        # be hit). Refresh the watchdog timestamp so the keepalive's stall check
        # only fires on a genuine hang, not on a maker patiently resting.
        _stats["last_action_ts"] = time.time(); _write_stats()
        # Fill detection by balance delta (works for vault-funded fills).
        if side == "buy":
            if (b["base"] - bal0["base"]) > 0.005 and (bal0["quote"] - b["quote"]) > 0.005:
                _log(f"BUY fill: +{b['base']-bal0['base']:.4f} base"); return "filled"
        else:
            if (b["quote"] - bal0["quote"]) > 0.005 and (bal0["base"] - b["base"]) > 0.005:
                _log(f"SELL fill: +{b['quote']-bal0['quote']:.4f} USDso"); return "filled"
        if b["somi"] < GAS_RESERVE:
            return "gas"
        # Sit-and-drift: only consider re-quoting after REQUOTE_S, and only if
        # the book touch has moved away from our resting price. Otherwise SIT.
        if time.time() - placed >= REQUOTE_S:
            try:
                book = dex.get_orderbook(PAIR)
                touch = book["bid"] if side == "buy" else book["ask"]
                if touch is not None and abs(touch - resting_px) > DRIFT_TICKS * tick:
                    return "requote"
            except Exception:
                pass
            placed = time.time()  # reset; keep sitting


def run(dex, w3, smoke=False):
    assert not MARKETS[PAIR].get("native"), "native SOMI maker SELL unsupported on dreamDEX"
    tick, lot, minq = _pool_params(w3)
    _log(f"start wallet={ADDR} leg=${LEG_USD} margin={MARGIN_TICKS}t requote={REQUOTE_S}s drift={DRIFT_TICKS}t")

    _cancel(dex)  # cancel stragglers FIRST so any reserved base/quote returns
    time.sleep(3)
    b = _balances(w3)  # read AFTER cancel so freed inventory is counted
    _log(f"P balances: base={b['base']:.4f} quote={b['quote']:.4f} (w={b['w_quote']:.4f} v={b['v_quote']:.4f}) somi={b['somi']:.4f}")

    buy_px = None
    buy_qty = None
    # Inventory-aware start: if we already hold a sellable amount of base
    # (e.g. left over from a prior run or a taker buy), start LONG and sell it
    # as a maker (PostOnly sells fill here; taker sells silently reject on this
    # pool). Otherwise start flat and buy first.
    if b["base"] >= minq:
        buy_qty = round((b["base"] // lot) * lot, 10) if lot else b["base"]
        _stats["state"] = "long"
        _log(f"startup: holding {b['base']:.8f} base >= minQty {minq} -> start LONG, sell {buy_qty}")
    else:
        _stats["state"] = "flat"

    # Stamp a fresh heartbeat on startup so the keepalive's stall-watchdog
    # (which restarts us if last_action_ts goes stale) doesn't false-trigger
    # right after a restart.
    _stats["last_action"] = "startup"
    _stats["last_action_ts"] = time.time()
    _write_stats()

    while True:
        if _stats["realized_pnl"] <= -MAX_LOSS:
            _log(f"MAX_LOSS backstop hit ({_stats['realized_pnl']:+.4f}) — stopping."); break
        try:
            b = _balances(w3)
            if b["somi"] < GAS_RESERVE:
                _log(f"SOMI {b['somi']:.3f} < reserve {GAS_RESERVE} — holding (no placements).");
                if smoke: return False
                time.sleep(60); continue

            book = dex.get_orderbook(PAIR)
            bid, ask = book.get("bid"), book.get("ask")
            if bid is None or ask is None:
                _log("empty book — wait"); time.sleep(15); continue

            if _stats["state"] == "flat":
                buy_px = _snap(bid, tick)
                if buy_px >= ask:
                    _log(f"bid {buy_px} >= ask {ask}; would cross — wait"); time.sleep(10); continue
                buy_qty = max(minq, round(round((LEG_USD / buy_px) / lot) * lot, 6))
                if FUNDING == "vault" and not _ensure_vault_usdso(dex, w3, buy_qty * buy_px + 0.02):
                    time.sleep(30); continue
                bal0 = _balances(w3)
                _log(f"POST BUY {buy_qty} @ {buy_px} (bid={bid} ask={ask})")
                r = dex.place_order(symbol=PAIR, side="buy", qty=buy_qty,
                                    order_type="postonly", limit_price=buy_px,
                                    funding=FUNDING, skip_sim=True)
                st = r.get("status", "")
                if st not in ("placed_unfilled", "success", "unverified"):
                    _log(f"BUY not resting (status={st}) — retry later"); _stats["errors"] += 1; time.sleep(10); continue
                time.sleep(2)
                _stats.update(open_order_id=_open_oid(dex), resting_px=buy_px,
                              last_action=f"buy_posted@{buy_px}", last_action_ts=time.time()); _write_stats()
                if smoke:
                    _log("smoke: BUY rested — cancelling."); time.sleep(8); _cancel(dex)
                    bf = _balances(w3)
                    ok = abs(bf["quote"] - bal0["quote"]) < 0.05
                    _log(f"smoke {'PASS' if ok else 'FAIL'} (quote delta {bf['quote']-bal0['quote']:+.5f})")
                    return ok
                out = _wait(dex, w3, "buy", bal0, buy_px, tick)
                _log(f"BUY outcome: {out}")
                if out == "filled":
                    _stats.update(state="long", fills=_stats["fills"]+1, open_order_id=None,
                                  last_action=f"buy_filled@{buy_px}", last_action_ts=time.time()); _write_stats()
                else:
                    _cancel(dex)
                    if out in ("gas",): time.sleep(60)

            elif _stats["state"] == "long":
                # SELL never below buy + margin. max(ask, floor) so we always
                # quote at-or-above the profitable floor; never cross the bid.
                floor = (buy_px or bid) + MARGIN_TICKS * tick
                sell_px = _snap(max(ask, floor), tick)
                if sell_px <= bid:
                    sell_px = _snap(bid + tick, tick)  # never cross; stay maker
                qty = buy_qty or max(minq, round(round((LEG_USD / sell_px) / lot) * lot, 6))
                bal0 = _balances(w3)
                _log(f"POST SELL {qty} @ {sell_px} (floor={floor:.4f} bid={bid} ask={ask} bought@{buy_px})")
                r = dex.place_order(symbol=PAIR, side="sell", qty=qty,
                                    order_type="postonly", limit_price=sell_px,
                                    funding=FUNDING, skip_sim=True)
                st = r.get("status", "")
                if st not in ("placed_unfilled", "success", "unverified"):
                    _log(f"SELL not resting (status={st}) — re-quote later"); _stats["errors"] += 1; _cancel(dex); time.sleep(10); continue
                time.sleep(2)
                _stats.update(open_order_id=_open_oid(dex), resting_px=sell_px,
                              last_action=f"sell_posted@{sell_px}", last_action_ts=time.time()); _write_stats()
                out = _wait(dex, w3, "sell", bal0, sell_px, tick)
                _log(f"SELL outcome: {out}")
                if out == "filled":
                    pnl = (sell_px - (buy_px or sell_px)) * qty
                    _stats.update(state="flat", fills=_stats["fills"]+1, rounds=_stats["rounds"]+1,
                                  realized_pnl=_stats["realized_pnl"]+pnl, open_order_id=None,
                                  last_action=f"sell_filled@{sell_px} pnl={pnl:+.5f}", last_action_ts=time.time())
                    _write_stats(); buy_px = buy_qty = None
                    _log(f"ROUND DONE pnl={pnl:+.5f} cum={_stats['realized_pnl']:+.5f}")
                else:
                    _cancel(dex)  # stay long; re-quote SELL next iteration (never below floor)
                    if out in ("gas",): time.sleep(60)
        except KeyboardInterrupt:
            break
        except Exception as e:
            _log(f"loop err: {e}"); import traceback; traceback.print_exc()
            _stats["errors"] += 1; time.sleep(10)

    _log("cleanup: cancel open order")
    try: _cancel(dex)
    except Exception: pass
    _write_stats()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--shutdown", action="store_true",
                    help="cancel any open order on PAIR and exit (frees vault funds for hand-off)")
    args = ap.parse_args()
    if args.shutdown:
        dex = DreamDEX(private_key=KEY, address=ADDR)
        ok = _cancel(dex)
        _log(f"shutdown: open order cancelled={ok}")
        return
    if not args.smoke:
        _acquire_pid()
        signal.signal(signal.SIGTERM, lambda *_: (_release_pid(), sys.exit(0)))
    try:
        dex = DreamDEX(private_key=KEY, address=ADDR)
        w3 = dex.wallet.w3
        run(dex, w3, smoke=args.smoke)
    finally:
        if not args.smoke:
            _release_pid()


if __name__ == "__main__":
    main()
