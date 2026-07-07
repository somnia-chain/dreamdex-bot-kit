# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Scan multiple USDso pairs and rank maker opportunities."""
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, List, Optional, Tuple

if TYPE_CHECKING:
    from executor import LiveDreamDexBot, Market


@dataclass
class PairWatchReport:
    symbol: str
    spread_bps: int
    edge_bps: int
    base_mid_usdso: Decimal
    market_ok: bool
    market_buy: bool
    market_sell: bool
    wallet_buy: bool
    wallet_sell: bool
    wallet_buy_note: str
    wallet_sell_note: str
    score: float


@dataclass
class MarketOpportunity:
    symbol: str
    spread_bps: int
    edge_bps: int
    score: float
    best_bid: int
    best_ask: int
    bid_price: int
    ask_price: int
    quote_bid: bool
    quote_ask: bool
    base_mid_usdso: Decimal


class MarketScanner:
    def __init__(self, bot: "LiveDreamDexBot"):
        self.bot = bot
        cfg = bot.cfg
        self.min_profitable_spread_bps = int(cfg.get("min_profitable_spread_bps", 20))
        self.max_spread_bps = int(cfg.get("max_spread_bps", 80))
        self.min_pair_score = float(cfg.get("min_pair_score", 20))
        self.maker_mode = str(cfg.get("maker_mode", "touch"))
        self.maker_spread_ticks = int(cfg.get("maker_spread_ticks", 1))
        self.maker_improve_ticks = int(cfg.get("maker_improve_ticks", 0))
        self.inventory_skew_bps = int(cfg.get("inventory_skew_bps", 300))
        self.target_inventory_ratio = float(cfg.get("target_inventory_ratio", 0.5))
        self.stablecoin_symbols = {
            s.upper() for s in cfg.get("stablecoin_symbols", ["USDC.e:USDso"])
        }
        self.stablecoin_target = Decimal(str(cfg.get("stablecoin_target_price", "1.0")))
        self.pair_min_spread_bps = {
            str(k): int(v) for k, v in cfg.get("pair_min_spread_bps", {}).items()
        }

    def _min_spread_for(self, symbol: str, default: Optional[int] = None) -> int:
        if symbol in self.pair_min_spread_bps:
            return self.pair_min_spread_bps[symbol]
        if default is not None:
            return default
        return self.min_profitable_spread_bps

    def _maker_prices(self, market: "Market", best_bid: int, best_ask: int) -> tuple[int, int]:
        bot = self.bot
        prev = bot.market
        bot.market = market
        try:
            if self.maker_mode == "touch":
                bid_price = bot._maker_price_touch(True, best_bid, best_ask, self.maker_improve_ticks)
                ask_price = bot._maker_price_touch(False, best_bid, best_ask, self.maker_improve_ticks)
            else:
                mid = bot._mid_price_raw(best_bid, best_ask)
                bid_price = bot._maker_price(True, mid, self.maker_spread_ticks)
                ask_price = bot._maker_price(False, mid, self.maker_spread_ticks)
            return bid_price, ask_price
        finally:
            bot.market = prev

    def _edge_bps(self, bid_price: int, ask_price: int) -> int:
        if bid_price <= 0 or ask_price <= 0 or ask_price <= bid_price:
            return 0
        mid = (bid_price + ask_price) // 2
        return int((ask_price - bid_price) * 10_000 // max(1, mid))

    def _base_mid_human(self, market: "Market", best_bid: int, best_ask: int) -> Decimal:
        mid_raw = (best_bid + best_ask) // 2
        return Decimal(mid_raw) / (Decimal(10) ** market.quote_decimals)

    def _score_opportunity(
        self,
        market: "Market",
        spread_bps: int,
        edge_bps: int,
        quote_bid: bool,
        quote_ask: bool,
        base_mid: Decimal,
        min_spread_bps: Optional[int] = None,
    ) -> float:
        min_edge = self.min_profitable_spread_bps if min_spread_bps is None else min_spread_bps
        if spread_bps > self.max_spread_bps or edge_bps < min_edge:
            return 0.0
        if not quote_bid and not quote_ask:
            return 0.0

        score = float(edge_bps)
        if quote_bid and quote_ask:
            score += 8.0

        if quote_bid and market.base_is_native:
            score -= 2.0

        return score

    def evaluate(
        self,
        symbol: str,
        *,
        min_spread_bps: Optional[int] = None,
        min_score: Optional[float] = None,
    ) -> Optional[MarketOpportunity]:
        bot = self.bot
        market = bot.markets_registry.get(symbol)
        if market is None:
            return None

        best_bid, best_ask = bot._best_prices_for(market)
        if best_bid is None or best_ask is None:
            return None

        spread_bps = bot._spread_bps(best_bid, best_ask)
        bid_price, ask_price = self._maker_prices(market, best_bid, best_ask)
        edge_bps = self._edge_bps(bid_price, ask_price)

        prev = bot.market
        bot.market = market
        try:
            quote_bid, quote_ask = bot._inventory_quote_sides(
                best_bid,
                best_ask,
                self.target_inventory_ratio,
                self.inventory_skew_bps,
            )
        finally:
            bot.market = prev

        base_mid = self._base_mid_human(market, best_bid, best_ask)
        score = self._score_opportunity(
            market, spread_bps, edge_bps, quote_bid, quote_ask, base_mid, min_spread_bps=min_spread_bps
        )
        score += self._wallet_action_bonus(market, quote_bid, quote_ask, bid_price, ask_price, best_bid, best_ask)
        threshold = self.min_pair_score if min_score is None else min_score
        if score < threshold:
            return None

        return MarketOpportunity(
            symbol=symbol,
            spread_bps=spread_bps,
            edge_bps=edge_bps,
            score=score,
            best_bid=best_bid,
            best_ask=best_ask,
            bid_price=bid_price,
            ask_price=ask_price,
            quote_bid=quote_bid,
            quote_ask=quote_ask,
            base_mid_usdso=base_mid,
        )

    def _wallet_action_bonus(
        self,
        market: "Market",
        quote_bid: bool,
        quote_ask: bool,
        bid_price: int,
        ask_price: int,
        best_bid: int,
        best_ask: int,
    ) -> float:
        bot = self.bot
        if not hasattr(bot, "_buy_quantity_from_balance"):
            return 0.0
        bonus = 0.0
        if quote_bid and self._wallet_can_side(market, True, bid_price, ask_price, best_bid, best_ask)[0]:
            bonus += 4.0
        if quote_ask and self._wallet_can_side(market, False, bid_price, ask_price, best_bid, best_ask)[0]:
            bonus += 4.0
        return bonus

    def scan_all(
        self,
        *,
        min_spread_bps: Optional[int] = None,
        min_score: Optional[float] = None,
        symbols: Optional[List[str]] = None,
    ) -> List[MarketOpportunity]:
        opportunities: List[MarketOpportunity] = []
        for symbol in (symbols if symbols is not None else self.bot.watch_symbols):
            pair_min = self._min_spread_for(symbol, min_spread_bps)
            opp = self.evaluate(symbol, min_spread_bps=pair_min, min_score=min_score)
            if opp is not None:
                opportunities.append(opp)
        opportunities.sort(key=lambda item: item.score, reverse=True)
        return opportunities

    def best_pulse_candidate(
        self, min_spread_bps: int, symbols: Optional[List[str]] = None
    ) -> Optional[MarketOpportunity]:
        """Best pair for anti-DQ activity pulse when spreads are thin."""
        best: Optional[MarketOpportunity] = None
        for symbol in (symbols if symbols is not None else self.bot.watch_symbols):
            market = self.bot.markets_registry.get(symbol)
            if market is None:
                continue
            best_bid, best_ask = self.bot._best_prices_for(market)
            if best_bid is None or best_ask is None:
                continue
            spread_bps = self.bot._spread_bps(best_bid, best_ask)
            if spread_bps > self.max_spread_bps:
                continue
            bid_price, ask_price = self._maker_prices(market, best_bid, best_ask)
            edge_bps = self._edge_bps(bid_price, ask_price)
            pair_min = self._min_spread_for(symbol, min_spread_bps)
            if edge_bps < pair_min:
                continue

            prev = self.bot.market
            self.bot.market = market
            try:
                quote_bid, quote_ask = self.bot._inventory_quote_sides(
                    best_bid,
                    best_ask,
                    self.target_inventory_ratio,
                    self.inventory_skew_bps,
                )
            finally:
                self.bot.market = prev

            can_bid = quote_bid and self._wallet_can_side(
                market, True, bid_price, ask_price, best_bid, best_ask
            )[0]
            can_ask = quote_ask and self._wallet_can_side(
                market, False, bid_price, ask_price, best_bid, best_ask
            )[0]
            if not can_bid and not can_ask:
                continue

            base_mid = self._base_mid_human(market, best_bid, best_ask)
            score = float(edge_bps)
            if can_bid and can_ask:
                score += 6.0
            elif can_bid or can_ask:
                score += 3.0

            candidate = MarketOpportunity(
                symbol=symbol,
                spread_bps=spread_bps,
                edge_bps=edge_bps,
                score=score,
                best_bid=best_bid,
                best_ask=best_ask,
                bid_price=bid_price,
                ask_price=ask_price,
                quote_bid=can_bid,
                quote_ask=can_ask,
                base_mid_usdso=base_mid,
            )
            if best is None or candidate.score > best.score:
                best = candidate
        return best

    def _wallet_can_side(
        self,
        market: "Market",
        is_bid: bool,
        bid_price: int,
        ask_price: int,
        best_bid: int,
        best_ask: int,
    ) -> Tuple[bool, str]:
        bot = self.bot
        prev = bot.market
        bot.market = market
        try:
            price_raw = bid_price if is_bid else ask_price
            if price_raw <= 0:
                return False, "invalid price"
            if is_bid:
                quantity_raw = bot._buy_quantity_from_balance(bot._spendable_quote_balance(), price_raw)
                if quantity_raw < market.min_quantity:
                    code = market.quote_code or "USDso"
                    return False, f"need {code}"
                if market.base_is_native and bot.web3.eth.get_balance(bot.address) < bot.reserve_native_wei:
                    return False, "gas reserve"
                return True, ""
            quantity_raw = bot._sell_quantity_from_balance(bot._token_balance(market.base))
            if quantity_raw < market.min_quantity:
                code = market.base_code or "base"
                return False, f"need {code}"
            return True, ""
        finally:
            bot.market = prev

    def watch_pair(self, symbol: str) -> Optional[PairWatchReport]:
        bot = self.bot
        market = bot.markets_registry.get(symbol)
        if market is None:
            return None

        best_bid, best_ask = bot._best_prices_for(market)
        if best_bid is None or best_ask is None:
            return PairWatchReport(
                symbol=symbol,
                spread_bps=0,
                edge_bps=0,
                base_mid_usdso=Decimal(0),
                market_ok=False,
                market_buy=False,
                market_sell=False,
                wallet_buy=False,
                wallet_sell=False,
                wallet_buy_note="empty book",
                wallet_sell_note="empty book",
                score=0.0,
            )

        spread_bps = bot._spread_bps(best_bid, best_ask)
        bid_price, ask_price = self._maker_prices(market, best_bid, best_ask)
        edge_bps = self._edge_bps(bid_price, ask_price)
        base_mid = self._base_mid_human(market, best_bid, best_ask)
        pair_min = self._min_spread_for(symbol)
        market_ok = spread_bps <= self.max_spread_bps and edge_bps >= pair_min
        market_buy = market_ok and bid_price > 0
        market_sell = market_ok and ask_price > 0
        score = (
            float(self._score_opportunity(market, spread_bps, edge_bps, True, True, base_mid))
            if market_ok
            else 0.0
        )

        wallet_buy, wallet_buy_note = self._wallet_can_side(
            market, True, bid_price, ask_price, best_bid, best_ask
        )
        wallet_sell, wallet_sell_note = self._wallet_can_side(
            market, False, bid_price, ask_price, best_bid, best_ask
        )

        return PairWatchReport(
            symbol=symbol,
            spread_bps=spread_bps,
            edge_bps=edge_bps,
            base_mid_usdso=base_mid,
            market_ok=market_ok,
            market_buy=market_buy,
            market_sell=market_sell,
            wallet_buy=wallet_buy,
            wallet_sell=wallet_sell,
            wallet_buy_note=wallet_buy_note,
            wallet_sell_note=wallet_sell_note,
            score=score,
        )

    def scan_watch(self) -> List[PairWatchReport]:
        reports: List[PairWatchReport] = []
        for symbol in self.bot.watch_symbols:
            report = self.watch_pair(symbol)
            if report is not None:
                reports.append(report)
        reports.sort(key=lambda item: (item.market_ok, item.score, item.edge_bps), reverse=True)
        return reports

    def _format_side_note(self, market_side: bool, wallet_ok: bool, note: str, side: str) -> str:
        if not market_side:
            return ""
        if wallet_ok:
            return side
        suffix = note or "blocked"
        return f"{side}→{suffix}"

    def format_watch_summary(self, reports: List[PairWatchReport]) -> str:
        if not reports:
            return "no pairs watched"
        parts: List[str] = []
        for report in reports:
            if report.market_ok:
                market_tag = "market:OK"
            elif report.spread_bps > self.max_spread_bps:
                market_tag = f"market:wide({report.spread_bps}bps)"
            elif report.edge_bps >= self.min_profitable_spread_bps - 5:
                market_tag = f"market:near({report.edge_bps}/{self.min_profitable_spread_bps}bps)"
            else:
                market_tag = f"market:thin({report.edge_bps}bps)"

            sides: List[str] = []
            if report.wallet_buy:
                sides.append("buy")
            elif report.market_buy or report.edge_bps >= self.min_profitable_spread_bps - 5:
                if report.wallet_buy_note:
                    sides.append(f"buy→{report.wallet_buy_note}")

            if report.wallet_sell:
                sides.append("sell")
            elif report.market_sell or report.edge_bps >= self.min_profitable_spread_bps - 5:
                if report.wallet_sell_note:
                    sides.append(f"sell→{report.wallet_sell_note}")

            if not sides and report.market_ok:
                sides.append("buy+sell")
            wallet_tag = f"wallet:{','.join(sides)}" if sides else "wallet:—"

            parts.append(
                f"{report.symbol} mid={report.base_mid_usdso:.4f} "
                f"spread={report.spread_bps} edge={report.edge_bps} {market_tag} {wallet_tag}"
            )
        return " | ".join(parts)

    def format_cross_summary(self, opportunities: List[MarketOpportunity]) -> str:
        if not opportunities:
            return "no profitable pairs"
        parts = []
        for opp in opportunities[:6]:
            parts.append(f"{opp.symbol} edge={opp.edge_bps}bps mid={opp.base_mid_usdso:.4f}")
        return " | ".join(parts)
