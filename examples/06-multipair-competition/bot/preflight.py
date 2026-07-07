#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Read-only preflight: RPC, balances, order book, prepare-order simulation."""
import argparse
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv

_repo_root = Path(__file__).resolve().parent.parent
load_dotenv(_repo_root / ".env")

from executor import LiveDreamDexBot  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="DreamDEX Trade Bot preflight")
    parser.add_argument("--config", default="bot/config.yml")
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = _repo_root / config_path
    with open(config_path, "r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle)

    bot = LiveDreamDexBot(cfg)
    if bot.dry_run:
        print("DRY RUN mode — approvals and broadcasts are simulated only")
    bot._preflight_checks()
    if not bot.dry_run:
        bot._ensure_startup_allowances()

    best_bid, best_ask = bot._best_prices()
    if best_bid is None or best_ask is None:
        print("FAIL: no order book depth")
        return 1

    is_bid = bot._choose_side(best_bid, best_ask)
    if is_bid is None:
        print("FAIL: cannot buy or sell with current balances")
        return 1

    slippage = int(cfg.get("slippage_bps_rebalance", bot.slippage_bps))
    price_raw = bot._price_for_order(is_bid, best_bid, best_ask, slippage_bps=slippage)
    if is_bid:
        quantity_raw = bot._buy_quantity_from_balance(bot._spendable_quote_balance(), price_raw)
    else:
        quantity_raw = bot._sell_quantity_from_balance(bot._spendable_base_balance())

    if quantity_raw < bot.market.min_quantity:
        print(f"FAIL: quantity {quantity_raw} < min {bot.market.min_quantity}")
        return 1

    order_type = cfg.get("order_type_rebalance", "immediateOrCancel")
    side = "buy" if is_bid else "sell"
    gas_floor = bot._gas_limit_for_order(is_bid)
    print(f"Simulating {side}: qty={quantity_raw} price={price_raw} type={order_type} gas_floor={gas_floor}")

    prepared = bot._prepare_order(is_bid, quantity_raw, price_raw, order_type_api=order_type)
    success, order_id = bot._simulate_prepared_tx(prepared, is_bid)
    if not success:
        print("FAIL: placeOrder simulation returned success=false")
        return 1

    print(f"OK: placeOrder simulation passed (order_id={order_id}) — safe to run bot.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
