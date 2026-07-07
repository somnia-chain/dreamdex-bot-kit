#!/bin/bash
# reset_maker.sh — one-shot: flatten everything to USDso and (re)launch the maker
# on WBTC:USDso at $18 legs. Run detached (nohup) so an SSH drop can't half-finish it.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/reset_maker.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
echo "=== $(date -u +%FT%TZ) reset maker -> WBTC \$18 ===" >>"$LOG"

# pause keepalive during the reset
crontab -l 2>/dev/null | grep -v maker_keepalive | crontab -

# stop maker
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa profit_maker "$p/cmdline" 2>/dev/null && kill "${p##*/}";; esac; done' 2>>"$LOG"
sleep 5

# cancel the existing WETH maker order (current pair) -> frees vault
docker exec dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso python3 /app/profit_maker.py --shutdown' >>"$LOG" 2>&1
sleep 3

# vault -> wallet (base + USDso, all pools)
docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/auto_withdraw.py >>"$LOG" 2>&1
sleep 3

# all base -> USDso (sells leftover WETH dust) -> clean cash for $18 legs
docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/liquidate_to_usdso.py >>"$LOG" 2>&1
sleep 2

# relaunch maker on WBTC at $18
docker exec -d dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WBTC:USDso PROFIT_LEG_USD=18 PROFIT_POLL_S=5 python3 /app/profit_maker.py >>/tmp/maker.log 2>&1'
sleep 2

# re-enable keepalive (now WBTC $18)
( crontab -l 2>/dev/null; echo "*/5 * * * * $DIR/maker_keepalive.sh" ) | crontab -
echo "=== $(date -u +%FT%TZ) reset done ===" >>"$LOG"
