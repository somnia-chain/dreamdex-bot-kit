# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Read-only maker fill-rate measurement for the yield_maker go/no-go decision.

Records the live trade tape (public WS `trades.<symbol>` channel) alongside a
REST BBO poll, and computes how much taker flow a 1-tick-improved quote of a
given size would have captured with price priority. This answers "will the
yield_maker produce volume?" without risking capital — and without trusting
the WS orderbook channel that Phase 2 Finding 1 showed goes silently stale
(the REST poll is the pricing source of truth here).

Capture model
-------------
We assume a resting quote of --quote-size-usd per side, placed one tick
inside the BBO. Price priority means any taker trade on our side fills us
before the dominant maker, capped at min(trade_notional, quote_size).

  - optimistic capture: every taker trade on our side is counted.
  - conservative capture: after a fill we need --requote-sec to replace the
    quote, so further trades on that side inside the window are not counted.

A maker fill earns ~half the spread instead of paying it, so projected
capture $/hour is directly comparable to volume_mill's measured $/hour —
without the capital decay.

Usage:
    NETWORK=mainnet python -m tools.measure_maker_flow --duration-sec 1800
    python -m tools.measure_maker_flow --markets WETH:USDso,WBTC:USDso \
        --quote-size-usd 25 --requote-sec 6 --duration-sec 3600
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import httpx

from dreamdex_bot.config import Settings
from dreamdex_bot.core.ws_client import WsClient


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


@dataclass
class Bbo:
    bid: Decimal | None = None
    ask: Decimal | None = None
    ts: float = 0.0

    @property
    def mid(self) -> Decimal | None:
        if self.bid is None or self.ask is None:
            return None
        return (self.bid + self.ask) / Decimal("2")

    @property
    def spread_bps(self) -> Decimal | None:
        mid = self.mid
        if mid is None or mid <= 0:
            return None
        return (self.ask - self.bid) / mid * Decimal("10000")


@dataclass
class SideTally:
    trades: int = 0
    notional: Decimal = Decimal("0")
    captured_optimistic: Decimal = Decimal("0")
    captured_conservative: Decimal = Decimal("0")
    last_capture_ts: float = 0.0


@dataclass
class MarketTally:
    buy: SideTally = field(default_factory=SideTally)
    sell: SideTally = field(default_factory=SideTally)
    unclassified: int = 0
    trade_ts: list[float] = field(default_factory=list)
    spread_samples: list[Decimal] = field(default_factory=list)

    @property
    def trades(self) -> int:
        return self.buy.trades + self.sell.trades + self.unclassified

    @property
    def notional(self) -> Decimal:
        return self.buy.notional + self.sell.notional

    @property
    def captured_optimistic(self) -> Decimal:
        return self.buy.captured_optimistic + self.sell.captured_optimistic

    @property
    def captured_conservative(self) -> Decimal:
        return self.buy.captured_conservative + self.sell.captured_conservative

    def median_gap_sec(self) -> float | None:
        if len(self.trade_ts) < 3:
            return None
        gaps = [b - a for a, b in zip(self.trade_ts, self.trade_ts[1:])]
        return statistics.median(gaps)

    def median_spread_bps(self) -> Decimal | None:
        if not self.spread_samples:
            return None
        return sorted(self.spread_samples)[len(self.spread_samples) // 2]


class FlowMeter:
    def __init__(
        self,
        markets: list[str],
        quote_size_usd: Decimal,
        requote_sec: float,
        out_path: Path,
    ) -> None:
        self.markets = markets
        self.quote_size_usd = quote_size_usd
        self.requote_sec = requote_sec
        self.bbo: dict[str, Bbo] = {m: Bbo() for m in markets}
        self.tally: dict[str, MarketTally] = {m: MarketTally() for m in markets}
        self.started = time.time()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        self._out = out_path.open("a")

    def _write(self, row: dict[str, Any]) -> None:
        self._out.write(json.dumps(row, default=str, sort_keys=True) + "\n")
        self._out.flush()

    async def on_trade(self, data: dict[str, Any]) -> None:
        market = str(data.get("market") or data.get("symbol") or "")
        if market not in self.tally:
            return
        now = time.time()
        price = _decimal(data.get("price"))
        qty = _decimal(data.get("quantity") or data.get("amount") or data.get("size"))
        if price is None or qty is None or price <= 0 or qty <= 0:
            self.tally[market].unclassified += 1
            return
        notional = price * qty

        # Taker side: trust an explicit side field first, else classify
        # against the REST mid (trade at/above mid → buyer was the taker).
        side = str(data.get("side", "")).lower()
        if side not in {"buy", "sell"}:
            mid = self.bbo[market].mid
            if mid is None:
                self.tally[market].unclassified += 1
                return
            side = "buy" if price >= mid else "sell"

        t = self.tally[market]
        st = t.buy if side == "buy" else t.sell
        st.trades += 1
        st.notional += notional
        t.trade_ts.append(now)

        capture = min(notional, self.quote_size_usd)
        st.captured_optimistic += capture
        if now - st.last_capture_ts >= self.requote_sec:
            st.captured_conservative += capture
            st.last_capture_ts = now

        self._write({
            "type": "trade", "ts": now, "market": market, "side": side,
            "price": price, "qty": qty, "notional": notional,
            "capture": capture,
        })

    async def poll_books(self, api_base: str, interval_sec: float, stop_at: float) -> None:
        async with httpx.AsyncClient(timeout=10.0) as client:
            while time.time() < stop_at:
                t0 = time.time()
                # The API returns an empty list for multi-symbol queries —
                # fetch one symbol per request like market_watch does.
                for sym in self.markets:
                    try:
                        r = await client.get(
                            f"{api_base.rstrip('/')}/v0/orderbooks",
                            params={"symbols": sym, "depth": 5},
                        )
                        r.raise_for_status()
                        for book in r.json().get("orderbooks", []):
                            if book.get("symbol") != sym:
                                continue
                            bids, asks = book.get("bids", []), book.get("asks", [])
                            bid = _decimal(bids[0].get("price")) if bids else None
                            ask = _decimal(asks[0].get("price")) if asks else None
                            self.bbo[sym] = Bbo(bid=bid, ask=ask, ts=time.time())
                            spread = self.bbo[sym].spread_bps
                            if spread is not None:
                                self.tally[sym].spread_samples.append(spread)
                    except Exception as exc:
                        self._write({"type": "book_error", "ts": time.time(),
                                     "market": sym, "error": str(exc)})
                await asyncio.sleep(max(0.0, interval_sec - (time.time() - t0)))

    def summary(self, final: bool = False) -> list[dict[str, Any]]:
        elapsed_h = max((time.time() - self.started) / 3600.0, 1e-9)
        rows = []
        for m in self.markets:
            t = self.tally[m]
            row = {
                "type": "summary_final" if final else "summary",
                "ts": time.time(),
                "market": m,
                "elapsed_min": round(elapsed_h * 60, 1),
                "trades": t.trades,
                "trades_per_min": round(t.trades / (elapsed_h * 60), 2),
                "taker_buy_usd": t.buy.notional,
                "taker_sell_usd": t.sell.notional,
                "flow_usd_per_hour": Decimal(round(float(t.notional) / elapsed_h, 2)),
                "capture_optimistic_usd_per_hour": Decimal(
                    round(float(t.captured_optimistic) / elapsed_h, 2)),
                "capture_conservative_usd_per_hour": Decimal(
                    round(float(t.captured_conservative) / elapsed_h, 2)),
                "median_trade_gap_sec": t.median_gap_sec(),
                "median_spread_bps": t.median_spread_bps(),
                "unclassified": t.unclassified,
                "bbo_age_sec": round(time.time() - self.bbo[m].ts, 1),
            }
            rows.append(row)
            self._write(row)
        return rows


async def run(args: argparse.Namespace) -> None:
    settings = Settings()
    markets = [m.strip() for m in args.markets.split(",") if m.strip()]
    meter = FlowMeter(
        markets=markets,
        quote_size_usd=Decimal(str(args.quote_size_usd)),
        requote_sec=args.requote_sec,
        out_path=Path(args.output),
    )
    ws = WsClient(url=settings.ws_url)
    for m in markets:
        ws.subscribe(f"trades.{m}", meter.on_trade)

    stop_at = time.time() + args.duration_sec
    ws_task = asyncio.create_task(ws.start())
    book_task = asyncio.create_task(
        meter.poll_books(settings.api_url, args.book_interval_sec, stop_at))

    print(f"measuring {markets} for {args.duration_sec:.0f}s "
          f"(quote_size=${args.quote_size_usd}, requote={args.requote_sec}s) "
          f"→ {args.output}")
    try:
        while time.time() < stop_at:
            await asyncio.sleep(min(60.0, max(1.0, stop_at - time.time())))
            for row in meter.summary():
                print(json.dumps(row, default=str))
    finally:
        ws.stop()
        book_task.cancel()
        ws_task.cancel()
        await asyncio.gather(ws_task, book_task, return_exceptions=True)
        print("--- FINAL ---")
        for row in meter.summary(final=True):
            print(json.dumps(row, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only maker capture measurement")
    parser.add_argument("--markets", default="WETH:USDso,WBTC:USDso,SOMI:USDso")
    parser.add_argument("--duration-sec", type=float, default=1800.0)
    parser.add_argument("--quote-size-usd", type=float, default=25.0)
    parser.add_argument("--requote-sec", type=float, default=6.0,
                        help="Seconds to replace a quote after a fill (conservative model)")
    parser.add_argument("--book-interval-sec", type=float, default=5.0)
    parser.add_argument("--output", default="logs/maker-flow-measure.jsonl")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
