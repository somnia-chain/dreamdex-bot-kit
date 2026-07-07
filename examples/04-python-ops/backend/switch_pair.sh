#!/bin/bash
# switch_pair.sh — drop-safe pair switch. Run detached via nohup so an SSH drop
# can't leave a half-done state. Sequence: disable keepalive -> kill burst ->
# liquidate all base (USDC.e etc) back to USDso -> relaunch burst on the new
# default pair (set in run_direct_burst.sh) -> re-enable keepalive.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/switch_pair.log"
mkdir -p "$DIR/logs"
echo "=== $(date -u +%FT%TZ) switch_pair start ===" >>"$LOG"

# 1. disable keepalive so it can't relaunch the burst mid-switch
crontab -l 2>/dev/null | grep -v burst_keepalive | crontab -

# 2. kill burst (in-container python + host wrapper)
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) ;; *) continue;; esac; grep -qa /app/direct_burst.py "$p/cmdline" 2>/dev/null && kill "${p##*/}"; done' 2>>"$LOG"
pkill -f "/app/direct_burst.py" 2>>"$LOG"
sleep 6
if pgrep -f "/app/direct_burst.py" >/dev/null; then
  echo "$(date -u +%FT%TZ) ABORT: burst still alive after kill" >>"$LOG"
  ( crontab -l 2>/dev/null; echo "*/2 * * * * $DIR/burst_keepalive.sh" ) | crontab -
  exit 1
fi
echo "$(date -u +%FT%TZ) burst stopped" >>"$LOG"

# 3. liquidate all base tokens -> USDso (skips native SOMI)
docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/liquidate_to_usdso.py >>"$LOG" 2>&1

# 4. relaunch burst on the new default pair (run_direct_burst.sh default = WETH:USDso)
nohup "$DIR/run_direct_burst.sh" >> "$DIR/logs/direct_burst.log" 2>&1 &
sleep 3

# 5. re-enable keepalive
( crontab -l 2>/dev/null; echo "*/2 * * * * $DIR/burst_keepalive.sh" ) | crontab -
echo "=== $(date -u +%FT%TZ) switch_pair done ===" >>"$LOG"
