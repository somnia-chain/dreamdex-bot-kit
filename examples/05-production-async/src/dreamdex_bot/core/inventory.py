# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Inventory & PnL tracker.

Owns:
  - Wallet balances per token (ERC-20 + native)
  - Vault balances per market
  - Locked amounts (per-side, per-market) from open orders
  - Realized P&L (closed positions) and unrealized P&L (open positions)

Update sources:
  - Initial fetch at startup via Web3 (ERC-20 balanceOf + getBalance + pool.getVaultBalance)
  - Fill events from WS: adjust balances by qty + price, update locks
  - Order update events: update locked amounts when new orders rest or get cancelled
  - Periodic refresh on a slow loop in case we missed an event (defense in depth)

PnL model: simple weighted-average entry price per market.
  - BUY fill increments long position. New avg_entry = (old_position * old_entry + qty * fill_price) / (old_position + qty)
  - SELL fill while long: realized += (fill_price - avg_entry) * sell_qty.
    If sell_qty > position, the residual flips us short and resets avg_entry.

Quote/Base is *signed* by convention: positive base = long, positive quote = long quote (always true for spot).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from dreamdex_bot.config import MARKETS, MarketSymbol
from dreamdex_bot.interfaces.strategy import OwnInventory, Side
from dreamdex_bot.utils.logger import get_logger


log = get_logger(__name__)


ZERO = Decimal(0)


@dataclass
class PositionAccount:
    """Per-market position-and-PnL bookkeeping."""
    market: MarketSymbol
    # Position in base units. Positive = long, negative = short.
    position_base: Decimal = ZERO
    # Volume-weighted average entry price (in quote units per base). 0 if flat.
    avg_entry_price: Decimal = ZERO
    # Closed PnL accumulator, in USDso (= quote) units.
    realized_pnl_quote: Decimal = ZERO


@dataclass
class InventoryState:
    """One snapshot per market. Engine reads this; strategies receive it as
    OwnInventory through the strategy interface."""
    market: MarketSymbol
    # On-chain balances (free, unlocked)
    wallet_base: Decimal = ZERO
    wallet_quote: Decimal = ZERO
    vault_base: Decimal = ZERO
    vault_quote: Decimal = ZERO
    # Amounts reserved by resting maker orders (in their respective tokens)
    base_locked_in_orders: Decimal = ZERO
    quote_locked_in_orders: Decimal = ZERO
    # Position tracking
    account: PositionAccount = field(default=None)  # populated in __post_init__

    def __post_init__(self):
        if self.account is None:
            self.account = PositionAccount(market=self.market)

    @property
    def free_base(self) -> Decimal:
        """Base available to spend (across wallet + vault), excluding locks."""
        return self.wallet_base + self.vault_base - self.base_locked_in_orders

    @property
    def free_quote(self) -> Decimal:
        return self.wallet_quote + self.vault_quote - self.quote_locked_in_orders

    def to_own_inventory(self) -> OwnInventory:
        """Adapter to the strategy-facing OwnInventory dataclass."""
        return OwnInventory(
            market=self.market,
            base_balance=self.wallet_base + self.vault_base,
            quote_balance=self.wallet_quote + self.vault_quote,
            base_locked_in_orders=self.base_locked_in_orders,
            quote_locked_in_orders=self.quote_locked_in_orders,
            realized_pnl_usd=self.account.realized_pnl_quote,
            unrealized_pnl_usd=ZERO,  # filled in by engine which knows mark price
        )


class InventoryTracker:
    """Holds InventoryState per market and applies events.

    Thread/coroutine safety: caller is responsible for serializing applies.
    In our engine, all WS handlers run on the same event loop so this is fine.
    """

    def __init__(self, markets: list[MarketSymbol]) -> None:
        self.states: dict[MarketSymbol, InventoryState] = {
            m: InventoryState(market=m) for m in markets
        }

    # ────────────────────────────────────────────────────────────────
    # Bootstrapping
    # ────────────────────────────────────────────────────────────────

    def set_initial_balances(
        self,
        market: MarketSymbol,
        wallet_base: Decimal,
        wallet_quote: Decimal,
        vault_base: Decimal,
        vault_quote: Decimal,
    ) -> None:
        s = self.states[market]
        s.wallet_base = wallet_base
        s.wallet_quote = wallet_quote
        s.vault_base = vault_base
        s.vault_quote = vault_quote
        log.info(
            "inventory.initialized", market=market.value,
            wallet_base=str(wallet_base), wallet_quote=str(wallet_quote),
            vault_base=str(vault_base), vault_quote=str(vault_quote),
        )

    # ────────────────────────────────────────────────────────────────
    # Event handlers
    # ────────────────────────────────────────────────────────────────

    def on_order_placed(
        self,
        market: MarketSymbol,
        side: Side,
        qty: Decimal,
        price: Decimal,
    ) -> None:
        """A new resting order is on the book. Lock the funds it reserves."""
        s = self.states[market]
        if side == Side.BUY:
            s.quote_locked_in_orders += qty * price
        else:
            s.base_locked_in_orders += qty
        log.debug("inventory.locked", market=market.value, side=side.value,
                  qty=str(qty), price=str(price),
                  base_locked=str(s.base_locked_in_orders),
                  quote_locked=str(s.quote_locked_in_orders))

    def on_order_cancelled(
        self,
        market: MarketSymbol,
        side: Side,
        remaining_qty: Decimal,
        price: Decimal,
    ) -> None:
        """Free the locks for the remaining (unfilled) portion of an order."""
        s = self.states[market]
        if side == Side.BUY:
            s.quote_locked_in_orders = max(ZERO, s.quote_locked_in_orders - remaining_qty * price)
        else:
            s.base_locked_in_orders = max(ZERO, s.base_locked_in_orders - remaining_qty)

    def on_fill(
        self,
        market: MarketSymbol,
        side: Side,
        qty: Decimal,
        price: Decimal,
        funding: str,
        is_maker: bool,
    ) -> None:
        """Update balances, locks, and PnL on a fill event.

        Args:
            funding: "wallet" or "vault" — tells us which bucket to move funds in.
            is_maker: True if our order was the resting side; affects lock release.
        """
        s = self.states[market]

        # 1. Move balances
        if side == Side.BUY:
            # We received base, paid quote
            if funding == "wallet":
                s.wallet_quote -= qty * price
                s.wallet_base += qty
            else:
                s.vault_quote -= qty * price
                s.vault_base += qty
            if is_maker:
                # Our resting buy filled — release that portion of the quote lock
                s.quote_locked_in_orders = max(ZERO, s.quote_locked_in_orders - qty * price)
        else:
            if funding == "wallet":
                s.wallet_base -= qty
                s.wallet_quote += qty * price
            else:
                s.vault_base -= qty
                s.vault_quote += qty * price
            if is_maker:
                s.base_locked_in_orders = max(ZERO, s.base_locked_in_orders - qty)

        # 2. Update position and PnL using weighted-average entry
        acct = s.account
        signed_qty = qty if side == Side.BUY else -qty
        new_position = acct.position_base + signed_qty

        if acct.position_base == ZERO or (acct.position_base > 0) == (signed_qty > 0):
            # Opening or extending the same direction → update avg entry
            if new_position != ZERO:
                acct.avg_entry_price = (
                    acct.position_base * acct.avg_entry_price + signed_qty * price
                ) / new_position if new_position != ZERO else ZERO
        else:
            # Closing or reversing
            closing_qty = min(abs(signed_qty), abs(acct.position_base))
            sign = 1 if acct.position_base > 0 else -1
            # If long and selling: pnl = (sell_price - entry) * qty
            # If short and buying: pnl = (entry - buy_price) * qty
            pnl_per_unit = (price - acct.avg_entry_price) * sign
            acct.realized_pnl_quote += closing_qty * pnl_per_unit
            if new_position == ZERO:
                acct.avg_entry_price = ZERO
            elif (new_position > 0) != (acct.position_base > 0):
                # Position flipped — residual qty opens new direction at fill price
                acct.avg_entry_price = price
        acct.position_base = new_position

        log.info(
            "inventory.fill",
            market=market.value, side=side.value,
            qty=str(qty), price=str(price), funding=funding, is_maker=is_maker,
            new_position=str(acct.position_base), avg_entry=str(acct.avg_entry_price),
            realized_pnl=str(acct.realized_pnl_quote),
        )

    def get(self, market: MarketSymbol) -> InventoryState:
        return self.states[market]

    def unrealized_pnl(self, market: MarketSymbol, mark_price: Decimal) -> Decimal:
        """Compute MTM PnL of the open position at the given mark price."""
        acct = self.states[market].account
        if acct.position_base == ZERO:
            return ZERO
        sign = 1 if acct.position_base > 0 else -1
        return abs(acct.position_base) * (mark_price - acct.avg_entry_price) * sign

    def to_strategy_view(
        self,
        market_mark_prices: dict[MarketSymbol, Decimal],
    ) -> dict[MarketSymbol, OwnInventory]:
        """Return a dict of OwnInventory snapshots, with unrealized PnL filled in."""
        out: dict[MarketSymbol, OwnInventory] = {}
        for m, s in self.states.items():
            inv = s.to_own_inventory()
            mark = market_mark_prices.get(m)
            if mark is not None:
                inv.unrealized_pnl_usd = self.unrealized_pnl(m, mark)
            out[m] = inv
        return out
