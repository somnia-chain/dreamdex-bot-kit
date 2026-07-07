#!/bin/bash
# One-shot gas top-up that survives an SSH drop (run via nohup). Disables the
# keepalive cron so it can't race the swap on the wallet nonce, kills the burst,
# swaps USDso->SOMI, restarts the burst, re-enables keepalive.
# Arg 1 = USD of USDso to convert to SOMI (default 1.0).
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/gas_topup.log"
AMT="${1:-1.0}"
mkdir -p "$DIR/logs"
echo "=== $(date -u +%FT%TZ) gas_topup \$${AMT} ===" >> "$LOG"

# 1. Disable keepalive so it can't relaunch the burst mid-swap.
crontab -l 2>/dev/null | grep -v burst_keepalive | crontab -

# 2. Kill any running burst (in-container python + host wrapper).
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) ;; *) continue;; esac; grep -qa /app/direct_burst.py "$p/cmdline" 2>/dev/null && kill "${p##*/}"; done' 2>>"$LOG"
pkill -f "/app/direct_burst.py" 2>/dev/null
sleep 4

# 3. Buy SOMI gas with USDso (sells a little USDC.e first if wallet USDso is low).
docker exec -e GAS_BUY_USD="$AMT" dreamdex-agent python3 /app/buy_gas.py >> "$LOG" 2>&1

# 4. Restart the burst.
nohup "$DIR/run_direct_burst.sh" >> "$DIR/logs/direct_burst.log" 2>&1 &
sleep 3

# 5. Re-enable keepalive.
( crontab -l 2>/dev/null; echo "*/2 * * * * $DIR/burst_keepalive.sh" ) | crontab -
echo "=== $(date -u +%FT%TZ) gas_topup done ===" >> "$LOG"
