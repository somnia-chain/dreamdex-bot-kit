#!/usr/bin/env bash
# Helper to securely load .env and run the DreamDEX Trade Bot
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# Ensure config exists
if [ ! -f bot/config.yml ]; then
  if [ -f bot/config.yml.example ]; then
    cp bot/config.yml.example bot/config.yml
    echo "Copied bot/config.yml.example -> bot/config.yml"
  else
    echo "Missing bot/config.yml.example; please create bot/config.yml" >&2
    exit 1
  fi
fi

# Create .env.example if .env is missing
if [ ! -f .env ]; then
  cat > .env.example <<'EOF'
# Create a .env file containing your private key. Example:
# PRIVATE_KEY="0x0123456789abcdef..."
EOF
  echo "No .env found; created .env.example. Add your PRIVATE_KEY to .env and rerun."
  exit 0
fi

# Secure .env
chmod 600 .env || true

# Export .env safely to environment
set -a
source .env
set +a

# Activate virtualenv if it exists
if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# Run bot (foreground)
python3 -u bot/bot.py --config bot/config.yml
