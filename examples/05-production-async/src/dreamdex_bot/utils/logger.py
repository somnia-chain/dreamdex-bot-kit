# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Structured JSONL logger. Every bot event lands in logs/ as a JSON line
suitable for grep/jq postprocessing into feedback reports.

We use structlog over the stdlib logger because:
  - Native dict context (so we can attach order_id/tx_hash/strategy_name)
  - Easy JSON renderer for machine-readable logs
  - Doesn't munge the message format for humans (rich console renderer for dev)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import structlog


def configure(log_dir: str = "./logs", level: str = "INFO") -> None:
    """Call once at startup. Sets up:
      - logs/bot.jsonl — all events as JSON lines
      - logs/errors.jsonl — errors only
      - stdout — pretty-printed for humans
    """
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        timestamper,
        structlog.processors.StackInfoRenderer(),
    ]

    # Stdout: human-readable
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            processor=structlog.dev.ConsoleRenderer(colors=True),
            foreign_pre_chain=shared_processors,
        )
    )

    # bot.jsonl: machine-readable
    file_handler = logging.FileHandler(os.path.join(log_dir, "bot.jsonl"))
    file_handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            processor=structlog.processors.JSONRenderer(),
            foreign_pre_chain=shared_processors,
        )
    )

    # errors.jsonl: errors only, machine-readable
    err_handler = logging.FileHandler(os.path.join(log_dir, "errors.jsonl"))
    err_handler.setLevel(logging.WARNING)
    err_handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            processor=structlog.processors.JSONRenderer(),
            foreign_pre_chain=shared_processors,
        )
    )

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper()))
    root.handlers = [stdout_handler, file_handler, err_handler]

    structlog.configure(
        processors=shared_processors
        + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


# ────────────────────────────────────────────────────────────────────
# Probe/Evidence logger — for QA probes that need raw request/response
# pairs preserved for feedback reports.
# ────────────────────────────────────────────────────────────────────

class EvidenceLog:
    """Append-only JSONL log of probe evidence.

    Usage:
        evidence = EvidenceLog("logs/probes.jsonl")
        evidence.record(
            probe="tick_precision",
            request={"price": "1.00005", "...": ...},
            response={"status": 400, "body": {...}},
            verdict="rejected_as_expected",
            notes="rejection message did not specify which field"
        )

    The result is grep-able by probe name and verdict.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)

    def record(self, **kwargs: Any) -> None:
        entry = {"ts": time.time(), **kwargs}
        with open(self.path, "a") as f:
            f.write(json.dumps(entry, default=str) + "\n")
