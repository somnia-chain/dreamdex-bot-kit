# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import os

from dotenv import load_dotenv, find_dotenv

# Walk up from cwd to find .env (so root or strategy-local both work).
load_dotenv(find_dotenv(usecwd=True))


def _num(key: str, fallback: float) -> float:
    v = os.environ.get(key)
    return fallback if v in (None, "") else float(v)


def _str(key: str, fallback: str) -> str:
    return os.environ.get(key) or fallback


def _bool(key: str, fallback: bool) -> bool:
    v = os.environ.get(key)
    return fallback if v in (None, "") else v.lower() in ("1", "true")


class Config:
    symbol = _str("MM_SYMBOL", "USDC.e:USDso")
    half_spread_bps = _num("MM_HALF_SPREAD_BPS", 5)
    notional_usdso = _num("MM_NOTIONAL_USDSO", 20)
    target_inventory_usdso = _num("MM_TARGET_INVENTORY_USDSO", 0)
    inventory_skew_bps = _num("MM_INVENTORY_SKEW_BPS", 4)
    requote_trigger_bps = _num("MM_REQUOTE_TRIGGER_BPS", 3)
    max_book_spread_bps = _num("MM_MAX_BOOK_SPREAD_BPS", 50)
    interval_ms = _num("MM_INTERVAL_MS", 5000)
    dry_run = _bool("DRY_RUN", True)
