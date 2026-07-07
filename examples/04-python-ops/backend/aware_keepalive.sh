#!/bin/bash
# Relaunch the aware WETH burst if it died, provided there's gas to run.
# (Replaces burst_keepalive, which launched the broken stale-price direct_burst.)
set -u
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
DIR=/home/irony/dreamdex-agent
# already running? (match aware_burst in any container python cmdline)
run=$(docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa aware_burst "$p/cmdline" 2>/dev/null && { echo 1; break; };; esac; done')
[ "$run" = "1" ] && exit 0
# enough gas?
somi=$(docker exec dreamdex-agent python3 -c "from web3 import Web3; from config import SOMNIA_RPC; print('%.3f'%(Web3(Web3.HTTPProvider(SOMNIA_RPC,request_kwargs={'timeout':10})).eth.get_balance(Web3.to_checksum_address('$H'))/1e18))" 2>/dev/null)
[ -z "$somi" ] && exit 0
awk "BEGIN{exit !($somi > 1.2)}" || { echo "$(date -u +%FT%TZ) SOMI=$somi too low, not relaunching" >> "$DIR/logs/aware_keepalive.log"; exit 0; }
# make sure the latest engine is in the container, then relaunch
docker cp "$DIR/aware_burst.py" dreamdex-agent:/app/aware_burst.py 2>/dev/null
docker exec -d dreamdex-agent sh -c 'BURST_PAIR=WETH:USDso BURST_USDSO=44 BURST_SLIPPAGE_TICKS=3 BURST_CYCLES=99999 BURST_SELL_RETRIES=8 python3 /app/aware_burst.py > /tmp/aware.log 2>&1'
echo "$(date -u +%FT%TZ) relaunched aware burst (SOMI=$somi)" >> "$DIR/logs/aware_keepalive.log"
