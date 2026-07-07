#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "No .env found; please create .env with PRIVATE_KEY. Created .env.example earlier." >&2
  exit 1
fi

chmod 600 .env || true
set -a
source .env
set +a

if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

nohup python3 -u bot/bot.py --config bot/config.yml > bot.log 2>&1 &
echo "BOT_STARTED PID=$!"
