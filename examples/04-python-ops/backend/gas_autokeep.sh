#!/bin/bash
# gas_autokeep.sh — keep the burst's gas (SOMI) above a floor, hands-off.
# Cron checks H wallet SOMI often (cheap, read-only); only tops up when it dips
# below THRESH, so real top-ups stay infrequent. Each top-up spends TOPUP_USD max.
# Runs entirely on the server (local docker, no Tailscale dependency) so it keeps
# the burst alive even during an SSH/Tailscale outage.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/gas_autokeep.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
THRESH_SOMI=3.5      # top up when SOMI dips below this (burst stalls < 1.0)
TOPUP_USD=1.0        # max per top-up (user cap: 0.5–1.0 USDso)
mkdir -p "$DIR/logs"

# single instance — never overlap with a top-up already in progress
exec 9>"$DIR/.gas_autokeep.lock"
flock -n 9 || exit 0

SOMI=$(docker exec dreamdex-agent python3 -c "
from web3 import Web3
from config import SOMNIA_RPC
w3=Web3(Web3.HTTPProvider(SOMNIA_RPC,request_kwargs={'timeout':10}))
print('%.4f'%(w3.eth.get_balance(Web3.to_checksum_address('$H'))/1e18))
" 2>>"$LOG")

[ -z "$SOMI" ] && { echo "$(date -u +%FT%TZ) SOMI read failed" >>"$LOG"; exit 0; }

if awk "BEGIN{exit !($SOMI < $THRESH_SOMI)}"; then
  echo "$(date -u +%FT%TZ) SOMI=$SOMI < $THRESH_SOMI -> top up \$$TOPUP_USD" >>"$LOG"
  "$DIR/gas_topup.sh" "$TOPUP_USD" >>"$LOG" 2>&1
  echo "$(date -u +%FT%TZ) top-up done" >>"$LOG"
else
  echo "$(date -u +%FT%TZ) SOMI=$SOMI ok" >>"$LOG"
fi
