#!/usr/bin/env bash
# Fund the DreamDEX vault so the bot can place resting (postOnly) maker orders.
#
# Resting maker orders on DreamDEX must be funded from the on-chain vault
# (wallet funding is limited to IOC/FOK taker orders). This script approves and
# deposits USDso into the vault for the USDC.e:USDso market.
#
# Prereqs:
#   source ./env.sh           # loads PATH + your private key from .env
# Usage:
#   ./setup_vault.sh [AMOUNT_USDSO]   # default 45
#
# Each step is an on-chain tx (costs a little SOMI gas) and waits for
# confirmation before returning.
set -euo pipefail

SYMBOL="USDC.e:USDso"
AMOUNT="${1:-45}"

if ! command -v dreamdex >/dev/null 2>&1; then
  echo "dreamdex CLI not on PATH. Run:  source ./env.sh"; exit 1
fi
if [ -z "${DREAMDEX_PRIVATE_KEY:-}" ] && [ -z "${DREAMDEX_PASSWORD:-}" ]; then
  echo "No key loaded. Put your key in .env and run:  source ./env.sh"; exit 1
fi

echo "==> Wallet / vault status before funding"
dreamdex vault balance "$SYMBOL" --json || true

echo "==> Approving $AMOUNT USDso for the $SYMBOL vault"
dreamdex vault approve "$SYMBOL" --currency USDso --amount "$AMOUNT"

echo "==> Depositing $AMOUNT USDso into the $SYMBOL vault"
dreamdex vault deposit "$SYMBOL" --currency USDso --amount "$AMOUNT"

echo "==> Vault status after funding"
dreamdex vault balance "$SYMBOL" --json

echo "Done. The bot can now quote with --funding vault."
echo "Tip: as the bot acquires USDC.e it can be deposited too:"
echo "     dreamdex vault approve  $SYMBOL --currency USDC.e --amount <n>"
echo "     dreamdex vault deposit  $SYMBOL --currency USDC.e --amount <n>"
