#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
DreamDEX production market-making bot  —  Alpha Trading Competition.

Goal: generate the MOST trading volume per dollar of capital, on the cheapest
venue, as a MAKER (so other bots pay the spread to us instead of the reverse).

Why maker-on-the-stable-pair wins
----------------------------------
The leaderboard ranks by *volume*, but every round-trip costs the spread+fees,
so the volume leaders are all down ~$50. To climb without burning out you must
be efficient:
  1. Trade USDC.e:USDso — a stablecoin<->stablecoin pair pinned at ~1.0000,
     so there is almost no price risk to bleed you.
  2. Be the MAKER. A resting order that someone else hits earns volume at near
     zero (often negative) cost. We quote a postOnly bid at 0.9999 and ask at
     1.0001; every matched pair is +2 ticks gross — volume that pays for itself.
  3. Re-quote the instant a quote fills, so capital cycles continuously.

The bot is inventory-aware (keeps both sides funded so it can always quote),
reconciles orders to avoid wasting gas re-placing quotes that are still good,
and opportunistically TAKES any order that is priced through the peg (free
profit + volume).

Maker orders on DreamDEX must be vault-funded (wallet funding is IOC/FOK only),
so run `setup_vault.sh` first. Everything executes through the official
`dreamdex` Go CLI (SIWE auth + local signing + broadcast).

    source ./env.sh
    python3 mm_bot.py --dry-run --once      # inspect
    python3 mm_bot.py                        # run live

Ctrl-C cancels open orders and prints a summary.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP, getcontext

getcontext().prec = 40

# ---- Market constants for USDC.e:USDso (verified live via GET /v0/markets) ----
SYMBOL = "USDC.e:USDso"
BASE_CCY = "USDC.e"     # inventory token
QUOTE_CCY = "USDso"     # the $50 allocation
TICK = Decimal("0.0001")
LOT = Decimal("0.01")
MIN_QTY = Decimal("1")
PEG = Decimal("1.0000")

log = logging.getLogger("mmbot")


# --------------------------------------------------------------------------- #
@dataclass
class Config:
    dry_run: bool = False
    once: bool = False
    interval: float = 1.0
    order_size: Decimal = Decimal("15")   # base units per quote
    edge_ticks: int = 1                    # ticks from peg (fallback when not pegging)
    max_base: Decimal = Decimal("44")      # cap on USDC.e inventory
    take: bool = True                      # opportunistic taker fills
    funding: str = "vault"
    min_equity: Decimal = Decimal("2")     # kill-switch floor (quote-ccy value)
    peg_aggressive: bool = True            # quote AT peg on the side we need (win queue)
    churn: bool = False                    # actively TAKE to manufacture volume (spends capital)
    churn_band: int = 1                    # max ticks from peg we'll cross when churning


@dataclass
class Stats:
    cycles: int = 0
    orders_placed: int = 0
    takes: int = 0
    cancels: int = 0
    errors: int = 0
    volume_base: Decimal = Decimal("0")    # cumulative |Δ total base| (proxy)
    start_equity: Decimal | None = None
    last_total_base: Decimal | None = None
    last_vault: dict | None = None
    last_orders: list | None = None


# --------------------------------------------------------------------------- #
# CLI plumbing
# --------------------------------------------------------------------------- #
DREAMDEX = None


def resolve_cli() -> str:
    p = shutil.which("dreamdex") or os.path.expanduser("~/go/bin/dreamdex")
    if not (shutil.which("dreamdex") or os.path.exists(p)):
        sys.exit("ERROR: `dreamdex` CLI not found. Run `source ./env.sh` first.")
    return shutil.which("dreamdex") or p


def run(args, *, timeout=120, retries=1):
    """Run a dreamdex subcommand with --json; retry transient network errors."""
    cmd = [DREAMDEX, *args]
    if "--json" not in cmd:
        cmd.append("--json")
    last = (1, "", "not run")
    for attempt in range(retries + 1):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            last = (p.returncode, p.stdout, p.stderr)
        except subprocess.TimeoutExpired:
            last = (124, "", "timeout")
        rc = last[0]
        if rc in (0, 101):           # success / "no fills" are terminal, no retry
            return last
        if rc == 3 and attempt < retries:  # network error -> retry
            time.sleep(1.0)
            continue
        return last
    return last


def jrun(args, *, timeout=120):
    rc, out, err = run(args, timeout=timeout)
    if rc != 0:
        return None, rc, (err or out).strip()
    try:
        return json.loads(out), rc, ""
    except json.JSONDecodeError:
        return None, rc, (out + err).strip()


# --------------------------------------------------------------------------- #
def rprice(p: Decimal) -> Decimal:
    return (p / TICK).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * TICK


def rqty(q: Decimal) -> Decimal:
    return (q / LOT).quantize(Decimal("1"), rounding=ROUND_DOWN) * LOT


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
def get_book():
    data, rc, err = jrun(["orderbook", SYMBOL, "--depth", "5"])
    if data is None:
        log.warning("orderbook read failed rc=%s %s", rc, err)
        return None, None
    obs = data.get("orderbooks") or []
    if not obs:
        return None, None
    ob = obs[0]
    bids, asks = ob.get("bids") or [], ob.get("asks") or []
    bb = Decimal(bids[0]["price"]) if bids else None
    ba = Decimal(asks[0]["price"]) if asks else None
    return bb, ba


def get_vault():
    out = {BASE_CCY: None, QUOTE_CCY: None}
    data, rc, err = jrun(["vault", "balance", SYMBOL])
    if data is None:
        log.warning("vault balance read failed rc=%s %s", rc, err)
        return out
    for r in (data.get("balances") or []):
        c, a = r.get("currency"), r.get("amount")
        if c in out and a is not None:
            out[c] = Decimal(str(a))
    return out


def get_open_orders():
    data, rc, err = jrun(["order", "list", SYMBOL, "--status", "open"])
    if data is None:
        log.warning("order list failed rc=%s %s", rc, err)
        return []
    return data.get("orders") or []


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #
def place(cfg: Config, st: Stats, side, qty: Decimal, price: Decimal, otype):
    qty, price = rqty(qty), rprice(price)
    if qty < MIN_QTY:
        return False
    args = ["order", "place", SYMBOL, "--side", side, "--type", "limit",
            "--amount", f"{qty}", "--price", f"{price}",
            "--order-type", otype, "--funding-source", cfg.funding]
    label = f"{side.upper():4} {qty} @ {price} [{otype}]"
    if cfg.dry_run:
        log.info("DRY place %s", label)
        return True
    rc, out, err = run(args)
    if rc == 0:
        st.orders_placed += 1
        if otype in ("immediateOrCancel", "fillOrKill"):
            st.takes += 1
        log.info("PLACED %s", label)
        return True
    if rc == 101:
        log.info("no-fill %s", label)
        return False
    if rc < 0:   # killed by a signal (e.g. shutdown) — not a real error
        log.info("interrupted %s (signal %d)", label, -rc)
        return False
    st.errors += 1
    log.error("FAIL  %s rc=%s %s", label, rc, (err or out).strip()[:160])
    return False


def cancel(cfg: Config, st: Stats, oid):
    if cfg.dry_run:
        log.info("DRY cancel %s", oid)
        return
    rc, out, err = run(["order", "cancel", SYMBOL, str(oid)])
    if rc == 0:
        st.cancels += 1
        log.info("CANCEL %s", oid)
    else:
        log.warning("cancel %s rc=%s %s", oid, rc, (err or out).strip()[:120])


# --------------------------------------------------------------------------- #
def holdings(vault, orders):
    """Total holdings INCLUDING funds reserved in open orders (free balance alone
    understates equity while quotes rest). Returns (total_quote, total_base)."""
    fq, fb = vault.get(QUOTE_CCY), vault.get(BASE_CCY)
    if fq is None or fb is None:
        return None, None
    tq, tb = fq, fb
    for o in (orders or []):
        rem = Decimal(str(o.get("remaining", "0") or "0"))
        px = Decimal(str(o.get("price", "0") or "0"))
        if o.get("side") == "buy":      # quote reserved in resting bid
            tq += rem * px
        elif o.get("side") == "sell":   # base reserved in resting ask
            tb += rem
    return tq, tb


def equity(vault, orders) -> Decimal | None:
    tq, tb = holdings(vault, orders)
    return None if tq is None else tq + tb * PEG


def track_volume(st: Stats, vault, orders):
    """Volume proxy from total-base deltas (free + reserved-in-asks)."""
    _, tb = holdings(vault, orders)
    if tb is None:
        return
    if st.last_total_base is not None:
        st.volume_base += abs(tb - st.last_total_base)
    st.last_total_base = tb


def dashboard(st: Stats):
    vault, orders = st.last_vault or {}, st.last_orders or []
    eq = equity(vault, orders)
    pnl = (eq - st.start_equity) if (eq is not None and st.start_equity is not None) else None
    log.info("STATS cyc=%d placed=%d takes=%d cancels=%d err=%d | "
             "free: %s=%s %s=%s | open=%d | est.vol(base)=%.2f equity=%s pnl=%s",
             st.cycles, st.orders_placed, st.takes, st.cancels, st.errors,
             QUOTE_CCY, vault.get(QUOTE_CCY), BASE_CCY, vault.get(BASE_CCY),
             len(orders), st.volume_base,
             f"{eq:.4f}" if eq is not None else "?",
             f"{pnl:+.4f}" if pnl is not None else "?")


# --------------------------------------------------------------------------- #
# One cycle: reconcile two-sided quotes + opportunistic takes
# --------------------------------------------------------------------------- #
def cycle(cfg: Config, st: Stats):
    vault = get_vault()
    open_orders = get_open_orders()
    st.last_vault, st.last_orders = vault, open_orders
    track_volume(st, vault, open_orders)
    if st.start_equity is None:
        st.start_equity = equity(vault, open_orders)

    # kill-switch (uses true equity incl. reserved order funds)
    eq = equity(vault, open_orders)
    if eq is not None and eq < cfg.min_equity:
        log.error("equity %.4f below floor %.4f — stopping for safety", eq, cfg.min_equity)
        raise KeyboardInterrupt

    usdso = vault.get(QUOTE_CCY) or Decimal("0")
    usdce = vault.get(BASE_CCY) or Decimal("0")

    bb, ba = get_book()

    # ---- inventory-skewed, queue-winning quote prices ----
    # The whole cohort sits at 0.9999/1.0001, so flow splits by time priority.
    # We quote AT the peg (1.0000) on the side we need to rebalance — that jumps
    # the queue and wins the fills, at break-even price (fair value is 1.0000).
    target_inv = cfg.max_base / 2          # aim to hold ~half capital in base
    need_buy = usdce < target_inv          # low inventory -> lean to BUY
    need_sell = usdce > target_inv         # high inventory -> lean to SELL
    if cfg.peg_aggressive and need_buy:
        target_bid, target_ask = PEG, rprice(PEG + TICK)            # 1.0000 / 1.0001
    elif cfg.peg_aggressive and need_sell:
        target_bid, target_ask = rprice(PEG - TICK), PEG            # 0.9999 / 1.0000
    else:
        target_bid = rprice(PEG - cfg.edge_ticks * TICK)            # 0.9999
        target_ask = rprice(PEG + cfg.edge_ticks * TICK)            # 1.0001

    # ---- TAKER ----
    if cfg.take or cfg.churn:
        # churn band: how far from peg we'll cross to manufacture volume.
        # default (no churn): only take STRICTLY favorable prices (ask<=0.9999 /
        # bid>=1.0001) so we never collide with our own at-peg maker quotes.
        buy_to = rprice(PEG + cfg.churn_band * TICK) if cfg.churn else rprice(PEG - TICK)
        sell_to = rprice(PEG - cfg.churn_band * TICK) if cfg.churn else rprice(PEG + TICK)
        if ba is not None and ba <= buy_to and usdso >= ba * MIN_QTY and usdce < cfg.max_base:
            qty = min(cfg.order_size, rqty(usdso / ba))
            if qty >= MIN_QTY:
                log.info("TAKE buy: hit ask %s (<= %s)", ba, buy_to)
                if place(cfg, st, "buy", qty, ba, "immediateOrCancel"):
                    return  # refresh state next cycle
        if bb is not None and bb >= sell_to and usdce >= MIN_QTY:
            qty = min(cfg.order_size, usdce)
            if qty >= MIN_QTY:
                log.info("TAKE sell: hit bid %s (>= %s)", bb, sell_to)
                if place(cfg, st, "sell", qty, bb, "immediateOrCancel"):
                    return

    # ---- reconcile resting MAKER quotes (keep good ones, replace stale) ----
    cur_bid = next((o for o in open_orders if o.get("side") == "buy"), None)
    cur_ask = next((o for o in open_orders if o.get("side") == "sell"), None)

    # desired sizes from available inventory (this self-rebalances)
    want_more_base = usdce < cfg.max_base
    bid_size = min(cfg.order_size, rqty(usdso / target_bid)) if target_bid > 0 else Decimal(0)
    if not want_more_base:
        bid_size = Decimal(0)
    ask_size = min(cfg.order_size, usdce)

    # BID
    if bid_size >= MIN_QTY:
        if cur_bid and Decimal(cur_bid["price"]) == target_bid \
                and Decimal(cur_bid.get("remaining", "0")) >= MIN_QTY:
            pass  # still good — leave it (saves gas)
        else:
            if cur_bid:
                cancel(cfg, st, cur_bid.get("id"))
            place(cfg, st, "buy", bid_size, target_bid, "postOnly")
    elif cur_bid:
        cancel(cfg, st, cur_bid.get("id"))  # no funds/over inventory — pull it

    # ASK
    if ask_size >= MIN_QTY:
        if cur_ask and Decimal(cur_ask["price"]) == target_ask \
                and Decimal(cur_ask.get("remaining", "0")) >= MIN_QTY:
            pass
        else:
            if cur_ask:
                cancel(cfg, st, cur_ask.get("id"))
            place(cfg, st, "sell", ask_size, target_ask, "postOnly")
    elif cur_ask:
        cancel(cfg, st, cur_ask.get("id"))


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="DreamDEX production MM bot (USDC.e:USDso)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--size", default="15", help="base units (USDC.e) per quote")
    ap.add_argument("--edge-ticks", type=int, default=1, help="ticks from peg (fallback)")
    ap.add_argument("--max-base", default="44", help="max USDC.e inventory")
    ap.add_argument("--funding", choices=["vault", "wallet"], default="vault")
    ap.add_argument("--no-take", action="store_true")
    ap.add_argument("--no-peg", action="store_true",
                    help="disable peg-aggressive quoting (revert to 0.9999/1.0001)")
    ap.add_argument("--churn", action="store_true",
                    help="actively CROSS to manufacture volume (spends capital — max volume)")
    ap.add_argument("--churn-band", type=int, default=1,
                    help="max ticks from peg to cross when churning")
    ap.add_argument("--min-equity", default="2", help="kill-switch floor (quote ccy)")
    ap.add_argument("--logfile", default="bot.log")
    a = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler(a.logfile)],
    )

    global DREAMDEX
    DREAMDEX = resolve_cli()
    cfg = Config(
        dry_run=a.dry_run, once=a.once, interval=a.interval,
        order_size=rqty(Decimal(a.size)), edge_ticks=a.edge_ticks,
        max_base=Decimal(a.max_base), take=not a.no_take, funding=a.funding,
        min_equity=Decimal(a.min_equity), peg_aggressive=not a.no_peg,
        churn=a.churn, churn_band=a.churn_band,
    )
    st = Stats()

    log.info("=== DreamDEX MM bot [%s] %s ===",
             "DRY-RUN" if cfg.dry_run else "LIVE", SYMBOL)
    log.info("size=%s funding=%s interval=%ss max_base=%s peg_aggressive=%s churn=%s(band=%d) take=%s",
             cfg.order_size, cfg.funding, cfg.interval, cfg.max_base,
             cfg.peg_aggressive, cfg.churn, cfg.churn_band, cfg.take)

    stop = {"flag": False}

    def shutdown(*_):
        stop["flag"] = True
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while not stop["flag"]:
            st.cycles += 1
            try:
                cycle(cfg, st)
            except KeyboardInterrupt:
                break
            except Exception as e:
                st.errors += 1
                log.exception("cycle error: %s", e)
            dashboard(st)
            if cfg.once:
                break
            # responsive sleep so Ctrl-C is snappy
            slept = 0.0
            while slept < cfg.interval and not stop["flag"]:
                time.sleep(min(0.25, cfg.interval - slept))
                slept += 0.25
    finally:
        log.info("shutting down — cancelling open orders...")
        if not cfg.dry_run:
            for o in get_open_orders():
                cancel(cfg, st, o.get("id"))
        st.last_vault, st.last_orders = get_vault(), get_open_orders()
        dashboard(st)
        log.info("bye.")


if __name__ == "__main__":
    main()
