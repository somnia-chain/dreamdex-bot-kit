# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Probe runner CLI.

Usage:
    python -m dreamdex_bot.probes.run --probe rate_limit_burst
    python -m dreamdex_bot.probes.run --probe tick_precision --market USDC.e:USDso
    python -m dreamdex_bot.probes.run --list

Each probe writes evidence to logs/probes.jsonl. Use jq/grep to filter by probe
name and turn into feedback reports.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from dreamdex_bot.config import load_settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.core.signer import Signer
from dreamdex_bot.probes.probes import PROBES
from dreamdex_bot.utils.logger import EvidenceLog, configure, get_logger


async def run(probe_name: str, market: str) -> None:
    settings = load_settings()
    configure(settings.log_dir, settings.log_level)
    log = get_logger("probe.runner")

    if probe_name not in PROBES:
        log.error("probe.unknown", probe=probe_name, available=list(PROBES.keys()))
        sys.exit(1)

    signer = Signer(settings.rpc_url, settings.private_key, settings.chain_id)
    await signer.initialize()

    evidence = EvidenceLog(str(Path(settings.log_dir) / "probes.jsonl"))
    rest = RestClient(api_base=settings.api_url, signer=signer, evidence=evidence)

    log.info("probe.starting", probe=probe_name, market=market, network=settings.network)
    try:
        result = await PROBES[probe_name](rest, evidence, market)
        log.info("probe.completed", result=result)
        print(json.dumps(result, indent=2, default=str))
    finally:
        await rest.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", help="Probe name to run")
    parser.add_argument("--market", default="USDC.e:USDso", help="Market symbol")
    parser.add_argument("--list", action="store_true", help="List all probes")
    args = parser.parse_args()

    if args.list:
        for name in PROBES:
            print(name)
        return

    if not args.probe:
        parser.error("--probe is required (or use --list)")

    asyncio.run(run(args.probe, args.market))


if __name__ == "__main__":
    main()
