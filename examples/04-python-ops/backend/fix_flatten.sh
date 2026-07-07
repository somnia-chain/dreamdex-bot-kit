#!/bin/bash
# fix_flatten.sh — robustly flatten H to USDso, then launch maker on WBTC $18.
# Handles the dreamDEX "silent reject" by retrying liquidation up to 4x and
# verifying the WETH balance actually dropped. Run detached (nohup).
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/fix_flatten.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
WETH=0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8
echo "=== $(date -u +%FT%TZ) fix_flatten start ===" >>"$LOG"

crontab -l 2>/dev/null | grep -v maker_keepalive | crontab -

# stop maker
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa profit_maker "$p/cmdline" 2>/dev/null && kill "${p##*/}";; esac; done' 2>>"$LOG"
sleep 5

# cancel any open orders on BOTH pairs (avoid self-match blocking the taker sell)
for P in WETH:USDso WBTC:USDso; do
  docker exec dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR='"$P"' python3 /app/profit_maker.py --shutdown' >>"$LOG" 2>&1
  sleep 2
done

# vault -> wallet
docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/auto_withdraw.py >>"$LOG" 2>&1
sleep 3

# liquidate WETH -> USDso, retry until WETH wallet balance is dust (<0.001) or 4 tries
wbal() { docker exec dreamdex-agent python3 -c "from web3 import Web3; w3=Web3(Web3.HTTPProvider('https://api.infra.mainnet.somnia.network/',request_kwargs={'timeout':10})); abi=[{'name':'balanceOf','type':'function','stateMutability':'view','inputs':[{'name':'a','type':'address'}],'outputs':[{'name':'','type':'uint256'}]}]; print(w3.eth.contract(address=Web3.to_checksum_address('$WETH'),abi=abi).functions.balanceOf(Web3.to_checksum_address('$H')).call())"; }
for i in 1 2 3 4; do
  B=$(wbal 2>>"$LOG"); echo "$(date -u +%FT%TZ) try $i: WETH raw=$B" >>"$LOG"
  [ -n "$B" ] && [ "$B" -lt 1000000000000000 ] 2>/dev/null && { echo "WETH flattened" >>"$LOG"; break; }
  docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/liquidate_to_usdso.py >>"$LOG" 2>&1
  sleep 4
done

# relaunch maker on WBTC $18
docker exec -d dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WBTC:USDso PROFIT_LEG_USD=18 PROFIT_POLL_S=5 python3 /app/profit_maker.py >>/tmp/maker.log 2>&1'
sleep 2
( crontab -l 2>/dev/null; echo "*/5 * * * * $DIR/maker_keepalive.sh" ) | crontab -
echo "=== $(date -u +%FT%TZ) fix_flatten done ===" >>"$LOG"
