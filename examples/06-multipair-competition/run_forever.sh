#!/usr/bin/env bash
# Keeps the trading bot running: restarts on crash (use with nohup or systemd).
# Uses bot/config.yml (gitignored). Snapshot: bot/config.competition.yml
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "Missing .env with PRIVATE_KEY" >&2
  exit 1
fi

chmod 600 .env 2>/dev/null || true
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

mkdir -p logs
LOG="logs/bot-forever.log"

echo "DreamDEX Trade Bot supervisor started at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"

while true; do
  echo "Starting bot at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"
  python3 -u bot/bot.py --config bot/config.yml >>"$LOG" 2>&1 || true
  echo "Bot exited; restarting in 30s at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"
  sleep 30
done
