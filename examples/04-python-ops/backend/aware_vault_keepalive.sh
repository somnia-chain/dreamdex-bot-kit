#!/bin/bash
# Relaunch the WALLET-FUNDED vault-taker burst (aware_burst_vault.py) if it died,
# provided there's gas. This is the working engine after placeTakerOrderWithoutVault
# was disabled — it places IOC orders via the placeOrder API path (funding=wallet).
set -u
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
DIR=/home/irony/dreamdex-agent
# already running? (match aware_burst_vault specifically)
run=$(docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa aware_burst_vault "$p/cmdline" 2>/dev/null && { echo 1; break; };; esac; done')
[ "$run" = "1" ] && exit 0
# enough gas?
somi=$(docker exec dreamdex-agent python3 -c "from web3 import Web3; from config import SOMNIA_RPC; print('%.3f'%(Web3(Web3.HTTPProvider(SOMNIA_RPC,request_kwargs={'timeout':10})).eth.get_balance(Web3.to_checksum_address('$H'))/1e18))" 2>/dev/null)
[ -z "$somi" ] && exit 0
awk "BEGIN{exit !($somi > 1.2)}" || { echo "$(date -u +%FT%TZ) SOMI=$somi too low, not relaunching" >> "$DIR/logs/aware_vault_keepalive.log"; exit 0; }
# make sure the latest engine is in the container, then relaunch
docker cp "$DIR/aware_burst_vault.py" dreamdex-agent:/app/aware_burst_vault.py 2>/dev/null
docker exec -d dreamdex-agent sh -c 'BURST_PAIR=WETH:USDso BURST_USDSO=20 BURST_SLIPPAGE_TICKS=200 BURST_SOMI_GAS_RESERVE=0.2 BURST_CYCLES=99999 BURST_SELL_RETRIES=8 BURST_FUNDING=wallet python3 /app/aware_burst_vault.py > /tmp/avault.log 2>&1'
echo "$(date -u +%FT%TZ) relaunched vault-taker (SOMI=$somi)" >> "$DIR/logs/aware_vault_keepalive.log"
