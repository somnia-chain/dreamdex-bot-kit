#!/bin/bash
# maker_keepalive.sh — keep profit_maker alive AND unstuck. Cron every 5 min.
#  - if the maker process is dead -> relaunch
#  - if alive but STALLED (stats last_action_ts older than 600s) -> kill+relaunch
#    (catches the fill-detection freeze where it holds WETH but loops "cannot
#     fund vault" without progressing; the process stays alive so a plain
#     liveness check misses it). The inventory-aware restart sells the held WETH.
# Runs locally on the server (no Tailscale dep). Key read from container env.
set -u
DIR=/home/irony/dreamdex-agent
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
LOG="$DIR/logs/maker_keepalive.log"

launch() {
  docker exec -d dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso PROFIT_FUNDING=wallet PROFIT_LEG_USD=8 PROFIT_GAS_RESERVE_SOMI=0.1 PROFIT_MARGIN_TICKS=3 PROFIT_POLL_S=5 PROFIT_REQUOTE_S=120 PROFIT_DRIFT_TICKS=2 python3 /app/profit_maker.py >>/tmp/maker.log 2>&1'
}
kill_maker() {
  docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa profit_maker "$p/cmdline" 2>/dev/null && kill "${p##*/}";; esac; done' 2>>"$LOG"
}

# alive? docker exec exits 7 if a profit_maker python is found
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa profit_maker "$p/cmdline" 2>/dev/null && exit 7;; esac; done; exit 0'
if [ "$?" -ne 7 ]; then
  echo "$(date -u +%FT%TZ) dead -> relaunch" >>"$LOG"; launch; exit 0
fi

# alive — check for stall via stats heartbeat
STALE=$(docker exec dreamdex-agent python3 -c "
import json,time
try:
    d=json.load(open('/tmp/profit_maker_stats.json'))
    age=time.time()-float(d.get('last_action_ts',0))
    print('STALL' if age>600 else 'OK', int(age))
except Exception:
    print('OK 0')
" 2>/dev/null)
if [ "${STALE%% *}" = "STALL" ]; then
  echo "$(date -u +%FT%TZ) stalled ($STALE) -> kill+relaunch" >>"$LOG"
  kill_maker; sleep 4; launch
fi
