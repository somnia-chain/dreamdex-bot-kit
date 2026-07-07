#!/usr/bin/env bash
# DreamDEX competition environment.
# Usage:  source ./env.sh
#
# SECURITY: This file should hold NOTHING secret. Put your private key in
# `.secret.env` (gitignored, created by you) — never paste it into chat or
# commit it. This script only sets non-secret config and loads .secret.env
# if present.

# --- toolchain on PATH (Go-installed CLI lives in ~/go/bin) ---
export PATH="/opt/homebrew/bin:$HOME/go/bin:$PATH"

# --- DreamDEX endpoints (mainnet defaults; override only if told to) ---
export DREAMDEX_API_URL="https://api.dreamdex.io"
export DREAMDEX_RPC_URL="https://api.infra.mainnet.somnia.network"
export DREAMDEX_JSON="1"   # force JSON output for scripting

# --- load your secret key from .env or .secret.env (whichever exists) ---
# The file should contain ONE line:
#   export DREAMDEX_PRIVATE_KEY=0xYOUR_NEW_WALLET_PRIVATE_KEY
# Both .env and .secret.env are gitignored. NEVER commit or share this key.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_loaded=""
for f in "$HERE/.env" "$HERE/.secret.env"; do
  if [ -f "$f" ]; then
    set -a            # auto-export plain KEY=VALUE lines too
    # shellcheck disable=SC1090
    source "$f"
    set +a
    _loaded="$f"
  fi
done
if [ -n "$_loaded" ]; then
  echo "[env] loaded $_loaded (private key set: $([ -n "$DREAMDEX_PRIVATE_KEY" ] && echo yes || echo no))"
else
  echo "[env] no .env/.secret.env found — create one with your NEW wallet's key before trading."
fi

echo "[env] dreamdex: $(command -v dreamdex || echo 'NOT INSTALLED')"
echo "[env] API: $DREAMDEX_API_URL"
