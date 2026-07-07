#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import argparse
import asyncio
import logging
import signal
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv

# Load .env from repo root (works whether cwd is repo root or bot/)
_repo_root = Path(__file__).resolve().parent.parent
load_dotenv(_repo_root / ".env")
load_dotenv()

from executor import LiveDreamDexBot

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("bot.log", mode="a"),
    ],
)
logger = logging.getLogger(__name__)


def load_config(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


async def main():
    parser = argparse.ArgumentParser(description="DreamDEX Trade Bot")
    parser.add_argument("--config", default="bot/config.yml", help="Path to YAML config")
    args = parser.parse_args()

    config_path = Path(args.config)
    cfg = load_config(str(config_path))

    bot = LiveDreamDexBot(cfg)

    # Handle graceful shutdown
    def signal_handler(sig, frame):
        logger.info("Received shutdown signal, stopping bot...")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("Starting live bot — press Ctrl+C to stop")
    try:
        await bot.run()
    except KeyboardInterrupt:
        logger.info("Stopped by user")
    except Exception as e:
        logger.error(f"Bot crashed with error: {e}", exc_info=True)
        raise


if __name__ == "__main__":
    asyncio.run(main())
