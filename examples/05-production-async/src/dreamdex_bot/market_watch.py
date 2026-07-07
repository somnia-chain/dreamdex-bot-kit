# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Read-only market watcher for DreamDEX orderbook trend logging.

Usage:
    NETWORK=mainnet python -m dreamdex_bot.market_watch --duration-sec 1800

The watcher never authenticates, prepares orders, or broadcasts transactions.
It samples public REST orderbooks and writes one JSON object per market sample.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import httpx

from dreamdex_bot.config import MarketSymbol, Settings


@dataclass
class TrendPoint:
    ts: float
    mid: Decimal


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _level_px_qty(level: dict[str, Any]) -> tuple[Decimal | None, Decimal | None]:
    price = _decimal(level.get("price"))
    qty = _decimal(level.get("quantity", level.get("amount", level.get("size"))))
    return price, qty


def _depth_usd(levels: list[dict[str, Any]], max_levels: int = 5) -> Decimal:
    total = Decimal("0")
    for level in levels[:max_levels]:
        price, qty = _level_px_qty(level)
        if price is not None and qty is not None:
            total += price * qty
    return total


def _slope_bps(points: deque[TrendPoint], now_mid: Decimal) -> Decimal | None:
    if len(points) < 2:
        return None
    first = points[0]
    if first.mid <= 0:
        return None
    return (now_mid - first.mid) / first.mid * Decimal("10000")


def _classify(short_bps: Decimal | None, long_bps: Decimal | None) -> str:
    signal = long_bps if long_bps is not None else short_bps
    if signal is None:
        return "warming_up"
    if signal >= Decimal("5"):
        return "up"
    if signal <= Decimal("-5"):
        return "down"
    return "flat"


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


async def _fetch_orderbook(
    client: httpx.AsyncClient,
    api_base: str,
    market: str,
    depth: int,
) -> dict[str, Any]:
    r = await client.get(
        f"{api_base.rstrip('/')}/v0/orderbooks",
        params={"symbols": market, "depth": depth},
    )
    r.raise_for_status()
    data = r.json()
    for book in data.get("orderbooks", []):
        if book.get("symbol") == market:
            return book
    return {"symbol": market, "bids": [], "asks": [], "timestamp": None}


async def watch(
    *,
    markets: list[str],
    interval_sec: float,
    duration_sec: float,
    depth: int,
    output: Path,
) -> None:
    settings = Settings()
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    history: dict[str, deque[TrendPoint]] = {
        market: deque(maxlen=max(2, int(300 / interval_sec) + 5))
        for market in markets
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        with output.open("a") as f:
            while time.time() - started < duration_sec:
                sample_ts = time.time()
                for market in markets:
                    try:
                        book = await _fetch_orderbook(client, settings.api_url, market, depth)
                        bids = book.get("bids", [])
                        asks = book.get("asks", [])
                        best_bid, bid_qty = _level_px_qty(bids[0]) if bids else (None, None)
                        best_ask, ask_qty = _level_px_qty(asks[0]) if asks else (None, None)
                        mid = (
                            (best_bid + best_ask) / Decimal("2")
                            if best_bid is not None and best_ask is not None
                            else None
                        )
                        spread_bps = (
                            (best_ask - best_bid) / mid * Decimal("10000")
                            if mid and best_bid is not None and best_ask is not None
                            else None
                        )
                        if mid is not None:
                            history[market].append(TrendPoint(sample_ts, mid))

                        short_points = deque(
                            (p for p in history[market] if sample_ts - p.ts <= 60),
                            maxlen=len(history[market]),
                        )
                        long_points = deque(
                            (p for p in history[market] if sample_ts - p.ts <= 300),
                            maxlen=len(history[market]),
                        )
                        short_bps = _slope_bps(short_points, mid) if mid is not None else None
                        long_bps = _slope_bps(long_points, mid) if mid is not None else None
                        row = {
                            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sample_ts)),
                            "epoch": sample_ts,
                            "network": settings.network.value,
                            "market": market,
                            "rest_timestamp_ms": book.get("timestamp"),
                            "best_bid": best_bid,
                            "best_ask": best_ask,
                            "bid_qty": bid_qty,
                            "ask_qty": ask_qty,
                            "mid": mid,
                            "spread_bps": spread_bps,
                            "bid_depth_5_usd": _depth_usd(bids),
                            "ask_depth_5_usd": _depth_usd(asks),
                            "trend_60s_bps": short_bps,
                            "trend_300s_bps": long_bps,
                            "trend": _classify(short_bps, long_bps),
                        }
                    except Exception as exc:
                        row = {
                            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sample_ts)),
                            "epoch": sample_ts,
                            "network": settings.network.value,
                            "market": market,
                            "error": str(exc),
                        }
                    f.write(json.dumps(row, default=_json_default, sort_keys=True) + "\n")
                    f.flush()
                    print(json.dumps(row, default=_json_default, sort_keys=True))

                sleep_for = max(0.0, interval_sec - (time.time() - sample_ts))
                await asyncio.sleep(sleep_for)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only DreamDEX market trend watcher")
    parser.add_argument(
        "--markets",
        default="SOMI:USDso,WETH:USDso,WBTC:USDso",
        help="Comma-separated DreamDEX markets to sample",
    )
    parser.add_argument("--interval-sec", type=float, default=10.0)
    parser.add_argument("--duration-sec", type=float, default=1800.0)
    parser.add_argument("--depth", type=int, default=20)
    parser.add_argument(
        "--output",
        default="logs/market-watch.jsonl",
        help="JSONL output path",
    )
    args = parser.parse_args()
    markets = [m.strip() for m in args.markets.split(",") if m.strip()]
    for market in markets:
        MarketSymbol(market)
    asyncio.run(
        watch(
            markets=markets,
            interval_sec=args.interval_sec,
            duration_sec=args.duration_sec,
            depth=args.depth,
            output=Path(args.output),
        )
    )


if __name__ == "__main__":
    main()
