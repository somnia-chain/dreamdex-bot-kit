# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Runnable entry point:  python -m bot"""
from __future__ import annotations

import signal
import time
from datetime import datetime, timezone

from dreamdex_core import create_chain_context, Pool

from .config import Config
from .strategy import MarketMaker


def log(msg: str) -> None:
    print(f"[mm {datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def main() -> None:
    cfg = Config()
    ctx = create_chain_context()
    log(f"network={ctx.net.name} wallet={ctx.address} dryRun={cfg.dry_run}")

    pool = Pool.load(ctx, cfg.symbol)
    log(f"market {cfg.symbol} tick={pool.tick} lot={pool.lot} minQty={pool.min_qty}")

    mm = MarketMaker(pool, cfg, log)
    stop = {"v": False}

    def shutdown(*_):
        stop["v"] = True

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while not stop["v"]:
            try:
                mm.requote()
            except Exception as err:  # keep the loop alive
                log(f"requote error: {err}")
            time.sleep(cfg.interval_ms / 1000)
    finally:
        log("shutting down — cancelling open quotes…")
        mm.cancel_all()


if __name__ == "__main__":
    main()
