# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Main entry point. Wires settings → signer → REST → WS → strategies → risk → engine.

Usage:
    python -m bots.main                                  # uses default config for the active network
    python -m bots.main --config configs/testnet.yaml
    NETWORK=mainnet python -m bots.main --config configs/mainnet.yaml

The YAML config controls strategy and risk parameters. Env vars (.env) control
wallet, network selection, and runtime switches (which strategies are enabled,
risk caps). When --config is provided, YAML values take precedence over env
defaults for strategy/risk params; wallet/network/URLs always come from env.

For probes (separate from the main bot loop):
    python -m dreamdex_bot.probes.run --probe rate_limit_burst
"""

from __future__ import annotations

import argparse
import asyncio
import signal as sig_module
import sys
import time
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from dreamdex_bot.config import MarketSymbol, load_settings
from dreamdex_bot.core.engine import Engine
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.risk_manager import RiskManager
from dreamdex_bot.core.signer import Signer
from dreamdex_bot.core.ws_client import WsClient
from dreamdex_bot.strategies.volume_mill import VolumeMill
from dreamdex_bot.strategies.yield_maker import YieldMaker
from dreamdex_bot.utils.logger import EvidenceLog, configure, get_logger


DEFAULT_CONFIG = {
    "bot": {
        "starting_capital_usd": 50.00,
        "markets_to_watch": ["SOMI:USDso", "WETH:USDso", "WBTC:USDso"],
    },
    "bootstrap": {
        "enabled": True,
        "candidate_markets": ["SOMI:USDso", "WETH:USDso", "WBTC:USDso"],
        "min_quote_balance_usd": "5.00",
        "target_quote_to_spend_usd": "15.00",
        "max_quote_fraction": "0.40",
        "reserve_quote_usd": "5.00",
        "min_base_value_usd": "1.00",
        "min_ask_depth_usd": "5.00",
        "max_spread_bps": "50.0",
    },
    "strategies": {
        "volume_mill": {
            "enabled": True,
            "markets": ["SOMI:USDso", "WETH:USDso", "WBTC:USDso"],
            "cycle_interval_sec": 2.0,
            "size_per_cycle_usd": 2.00,
            "size_per_cycle_usd_by_market": {
                "SOMI:USDso": "2.00",
                "WETH:USDso": "4.00",
                "WBTC:USDso": "12.00",
            },
            "max_inventory_imbalance_usd": 3.00,
            "max_spread_bps": 75.0,
            "min_side_depth_usd": 2.50,
            "depth_usage_fraction": 0.50,
            "ioc_cross_bps": 5.0,
            "native_base_reserve_by_market": {
                "SOMI:USDso": "10.00",
            },
        },
        "yield_maker": {
            "enabled": False,
            "target_base_value_usd": 12.50,
            "quote_size_usd": 2.00,
            "min_half_spread_bps": 25,
            "gamma": 0.5,
            "k_vol": 2.0,
            "requote_threshold_bps": 5,
            "requote_min_interval_sec": 3.0,
            "vol_window": 60,
            "native_base_reserve_by_market": {
                "SOMI:USDso": "10.00",
            },
        },
    },
    "risk": {
        "realized_loss": {"max_loss_usd": "12.50"},
        "inventory_drift": {
            "market": "SOMI:USDso", "max_drift_usd": "10.00",
            "target_base_usd": "12.50", "strategy": "yield_maker",
            "native_base_reserve_by_market": {"SOMI:USDso": "10.00"},
        },
        "failed_tx_streak": {"max_streak": 5},
        "ws_staleness": {"max_silence_sec": 60.0},
        "open_orders_cap": {"max_open": 8},
        "max_drawdown": {"max_drawdown_pct": "30.0"},
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge override into base without mutating either input."""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_yaml_config(path: str | None) -> dict[str, Any]:
    """Load a YAML config and merge it on top of DEFAULT_CONFIG.

    Deep merge: partial strategy/risk overrides preserve nested defaults.
    """
    if path is None:
        return DEFAULT_CONFIG
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    with p.open() as f:
        loaded = yaml.safe_load(f) or {}
    return _deep_merge(DEFAULT_CONFIG, loaded)


async def main(config_path: str | None) -> None:
    settings = load_settings()
    configure(settings.log_dir, settings.log_level)
    log = get_logger("bot.main")
    log.info("bot.starting", network=settings.network.value, wallet=settings.wallet_address)

    cfg = load_yaml_config(config_path)
    log.info("bot.config_loaded", path=config_path or "<defaults>")
    report_dir = Path(settings.log_dir) / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    reporter = EvidenceLog(str(report_dir / "session.jsonl"))
    reporter.record(
        event="bot_starting",
        category="startup",
        network=settings.network.value,
        wallet=settings.wallet_address,
        config_path=config_path or "<defaults>",
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )

    # ─── Resolve markets — filter to what's actually available on the network ──
    desired = [MarketSymbol(s) for s in cfg["bot"]["markets_to_watch"]]
    for symbol in cfg.get("bootstrap", {}).get("candidate_markets", []):
        market = MarketSymbol(symbol)
        if market not in desired:
            desired.append(market)
    available = settings.available_markets()
    markets_to_watch = [m for m in desired if m in available]
    skipped = [m.value for m in desired if m not in available]
    if skipped:
        log.warning("bot.markets_skipped",
                    skipped=skipped, network=settings.network.value,
                    note="These markets are not deployed on the active network. "
                         "Common case: USDC.e:USDso is mainnet-only.")
    if not markets_to_watch:
        log.error("bot.no_markets_available", desired=cfg["bot"]["markets_to_watch"])
        sys.exit(1)

    # ─── Build components ─────────────────────────────────────────────
    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()

    rest = RestClient(api_base=settings.api_url, signer=signer, evidence=reporter)
    ws = WsClient(url=settings.ws_url, jwt_provider=rest.ensure_auth)

    # Sanity check: auth + read markets before going live
    try:
        markets = await rest.get_markets()
        log.info("bot.markets_loaded", count=len(markets.get("markets", markets)) if isinstance(markets, dict) else len(markets))
    except Exception as e:
        log.error("bot.market_fetch_failed", error=str(e))
        # Continue — the engine will retry per-market

    # ─── Strategies (driven by YAML, gated by env switches) ───────────
    strategies = []
    vm_cfg = cfg["strategies"].get("volume_mill", {})
    if settings.enable_volume_mill and vm_cfg.get("enabled", True):
        vm_markets_cfg = vm_cfg.get("markets") or [vm_cfg.get("market", "USDC.e:USDso")]
        for vm_market_str in vm_markets_cfg:
            vm_market = MarketSymbol(vm_market_str)
            if vm_market in markets_to_watch:
                strategies.append(VolumeMill({**vm_cfg, "market": vm_market.value}))
            else:
                log.warning("bot.volume_mill_skipped",
                            market=vm_market.value,
                            note="Configured market is not available on this network. "
                                 "Set strategies.volume_mill.markets to available markets.")
    ym_cfg = cfg["strategies"].get("yield_maker", {})
    if settings.enable_yield_maker and ym_cfg.get("enabled", True):
        ym_market = MarketSymbol(ym_cfg.get("market", MarketSymbol.SOMI_USDSO.value))
        if ym_market in markets_to_watch:
            strategies.append(YieldMaker(ym_cfg))
        else:
            log.warning("bot.yield_maker_skipped",
                        market=ym_market.value,
                        note="Configured maker market is not available on this network.")
    else:
        log.info(
            "bot.yield_maker_disabled",
            note="YieldMaker is intentionally disabled for Day 1 until maker/cancel behavior is paper-traded.",
        )
        reporter.record(
            event="yield_maker_disabled",
            category="startup",
            reason="Disabled for Day 1 pending paper trading of maker quotes, cancel IDs, and inventory parameters.",
        )

    if not strategies:
        log.error("bot.no_strategies_active", note="Check config and env switches.")
        reporter.record(event="bot_no_strategies_active", category="startup")
        sys.exit(1)
    reporter.record(
        event="strategies_configured",
        category="startup",
        strategies=[s.name for s in strategies],
        markets=[m.value for m in markets_to_watch],
    )

    # ─── Risk manager (from YAML) ─────────────────────────────────────
    risk = RiskManager.default(cfg["risk"])

    # ─── Engine ───────────────────────────────────────────────────────
    starting_capital = Decimal(str(cfg["bot"].get("starting_capital_usd", "50.00")))
    engine = Engine(
        settings=settings, signer=signer, rest=rest, ws=ws,
        strategies=strategies, risk=risk,
        starting_capital_usd=starting_capital,
        markets_to_watch=markets_to_watch,
        bootstrap_config=cfg.get("bootstrap", {}),
        approval_config=cfg.get("wallet_approvals", {}),
        unattended_config=cfg.get("unattended", {}),
        reporter=reporter,
        book_reconcile_config=cfg.get("book_reconcile", {}),
    )
    await engine.initialize()
    engine.register_ws_handlers()

    # ─── Graceful shutdown ────────────────────────────────────────────
    loop = asyncio.get_event_loop()
    stop_evt = asyncio.Event()
    for s in (sig_module.SIGTERM, sig_module.SIGINT):
        try:
            loop.add_signal_handler(s, stop_evt.set)
        except NotImplementedError:
            # Not supported on Windows
            pass

    async def shutdown_watcher():
        await stop_evt.wait()
        log.warning("bot.shutdown_requested")
        engine.request_safe_exit("signal_received")

    # ─── Run everything concurrently ──────────────────────────────────
    ws_task = asyncio.create_task(ws.start())
    nonce_task = asyncio.create_task(signer.nonces.reconcile_loop())
    engine_task = asyncio.create_task(engine.run())
    shutdown_task = asyncio.create_task(shutdown_watcher())
    try:
        done, _ = await asyncio.wait(
            {engine_task, shutdown_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if shutdown_task in done and not engine_task.done():
            try:
                await asyncio.wait_for(engine_task, timeout=120)
            except asyncio.TimeoutError:
                log.warning("bot.safe_exit_timeout")
                engine.stop()
    finally:
        ws.stop()
        signer.nonces.stop()
        for task in (ws_task, nonce_task, engine_task, shutdown_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            ws_task, nonce_task, engine_task, shutdown_task,
            return_exceptions=True,
        )
        reporter.record(
            event="bot_stopped",
            category="shutdown",
            stopped_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        await rest.close()
        log.info("bot.stopped")


def cli() -> None:
    parser = argparse.ArgumentParser(description="DreamDEX trading + QA bot")
    parser.add_argument("--config", help="Path to YAML config file (optional)")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.config))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    cli()
