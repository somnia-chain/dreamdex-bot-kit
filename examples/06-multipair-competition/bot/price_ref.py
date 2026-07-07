# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""External global price reference (Binance public API) for BTC/ETH.

Used by the momentum strategy to:
  1. Glitch filter   — reject DreamDEX WBTC/WETH mids that deviate from global price.
  2. Momentum signal — global short-term price momentum as a directional trigger.
  3. Lag arbitrage   — buy DreamDEX when it lags a global up-move.

CoinGlass (liquidations / OI) can be layered on later via `liquidation_signal()`
once an API key is provided; the hook returns None until configured.
"""
import asyncio
import logging
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

BINANCE_PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol={sym}"

# DreamDEX base code -> Binance spot symbol
DEFAULT_MAP = {
    "WBTC": "BTCUSDT", "BTC": "BTCUSDT",
    "WETH": "ETHUSDT", "ETH": "ETHUSDT",
}


class BinancePriceRef:
    def __init__(
        self,
        dex_to_binance: Dict[str, str],
        refresh_sec: float = 5.0,
        history_sec: float = 600.0,
        coinglass_api_key: Optional[str] = None,
    ):
        # maps DreamDEX symbol (e.g. "WBTC:USDso") -> binance symbol ("BTCUSDT")
        self.dex_to_binance = dex_to_binance
        self.refresh_sec = refresh_sec
        self.history_sec = history_sec
        self.coinglass_api_key = coinglass_api_key
        self._prices: Dict[str, float] = {}
        self._history: Dict[str, Deque[tuple]] = {
            s: deque() for s in dex_to_binance
        }
        self._task: Optional[asyncio.Task] = None
        self._connected = False
        # Reuse one pooled connection (keep-alive) to avoid ephemeral port exhaustion.
        self._session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=2)
        self._session.mount("https://", adapter)

    @property
    def connected(self) -> bool:
        return self._connected

    def _fetch_price(self, binance_sym: str) -> Optional[float]:
        try:
            r = self._session.get(BINANCE_PRICE_URL.format(sym=binance_sym), timeout=8)
            r.raise_for_status()
            return float(r.json()["price"])
        except Exception as exc:
            logger.debug(f"price_ref fetch {binance_sym} failed: {exc}")
            return None

    async def _refresh_once(self) -> None:
        for dex_sym, bsym in self.dex_to_binance.items():
            price = await asyncio.to_thread(self._fetch_price, bsym)
            if price is None or price <= 0:
                continue
            now = time.time()
            self._prices[dex_sym] = price
            hist = self._history[dex_sym]
            hist.append((now, price))
            cutoff = now - self.history_sec
            while hist and hist[0][0] < cutoff:
                hist.popleft()

    async def _loop(self) -> None:
        while True:
            try:
                await self._refresh_once()
                self._connected = any(p > 0 for p in self._prices.values())
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(f"price_ref loop error: {exc}")
            await asyncio.sleep(self.refresh_sec)

    async def start(self) -> None:
        if self._task is not None:
            return
        await self._refresh_once()  # warm up
        self._connected = any(p > 0 for p in self._prices.values())
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._connected = False

    # ---------- queries ----------
    def global_price(self, dex_symbol: str) -> Optional[float]:
        return self._prices.get(dex_symbol)

    def momentum_bps(self, dex_symbol: str, lookback_sec: float) -> Optional[int]:
        """Signed price change over lookback window, in bps. +ve = up-move."""
        hist = self._history.get(dex_symbol)
        if not hist:
            return None
        now = time.time()
        cutoff = now - lookback_sec
        past_price = None
        for ts, price in hist:
            if ts >= cutoff:
                past_price = price
                break
        if past_price is None or past_price <= 0:
            return None
        last = hist[-1][1]
        return int((last - past_price) * 10_000 // past_price)

    def deviation_pct(self, dex_symbol: str, dex_mid_usd: float) -> Optional[float]:
        """How far the DreamDEX mid is from global price, in percent."""
        gp = self._prices.get(dex_symbol)
        if gp is None or gp <= 0 or dex_mid_usd <= 0:
            return None
        return abs(dex_mid_usd - gp) / gp * 100.0

    # ---------- CoinGlass placeholder (enabled when key provided) ----------
    def liquidation_signal(self, dex_symbol: str) -> Optional[str]:
        """Return 'long'/'short' bias from liquidation cascades, or None.

        Stub: implemented once a CoinGlass API key is configured.
        """
        if not self.coinglass_api_key:
            return None
        return None


def build_map(momentum_pairs, markets_registry, overrides: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Map each momentum DreamDEX symbol to a Binance symbol via base code."""
    overrides = overrides or {}
    mapping: Dict[str, str] = {}
    for sym in momentum_pairs:
        if sym in overrides:
            mapping[sym] = overrides[sym]
            continue
        market = markets_registry.get(sym)
        base = (market.base_code if market else sym.split(":")[0]).upper()
        bsym = DEFAULT_MAP.get(base)
        if bsym:
            mapping[sym] = bsym
    return mapping
