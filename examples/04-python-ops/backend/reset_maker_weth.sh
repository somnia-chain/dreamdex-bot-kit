#!/bin/bash
# reset_maker_weth.sh — flush the stuck WETH to USDso at market (accept the small
# loss) and relaunch the maker FLAT on WETH:USDso $18 so it re-anchors to today's
# price and resumes cycling. Run detached (nohup) so an SSH drop can't half-finish.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/reset_maker_weth.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
WETH=0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8
echo "=== $(date -u +%FT%TZ) reset maker -> WETH \$18 (flush stuck inventory) ===" >>"$LOG"

# pause keepalive during the reset
crontab -l 2>/dev/null | grep -v maker_keepalive | crontab -

# stop maker (kill any running profit_maker)
docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qa profit_maker "$p/cmdline" 2>/dev/null && kill "${p##*/}";; esac; done' 2>>"$LOG"
sleep 5

# cancel the existing WETH maker order -> frees the stuck WETH to the wallet
docker exec dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso python3 /app/profit_maker.py --shutdown' >>"$LOG" 2>&1
sleep 3

# vault -> wallet (frees anything escrowed)
docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/auto_withdraw.py >>"$LOG" 2>&1
sleep 3

# sell WETH -> USDso at market, retry until WETH wallet is dust (<0.001) or 4 tries
wbal() { docker exec dreamdex-agent python3 -c "from web3 import Web3; w3=Web3(Web3.HTTPProvider('https://api.infra.mainnet.somnia.network/',request_kwargs={'timeout':10})); abi=[{'name':'balanceOf','type':'function','stateMutability':'view','inputs':[{'name':'a','type':'address'}],'outputs':[{'name':'','type':'uint256'}]}]; print(w3.eth.contract(address=Web3.to_checksum_address('$WETH'),abi=abi).functions.balanceOf(Web3.to_checksum_address('$H')).call())"; }
for i in 1 2 3 4; do
  B=$(wbal 2>>"$LOG"); echo "$(date -u +%FT%TZ) try $i: WETH raw=$B" >>"$LOG"
  [ -n "$B" ] && [ "$B" -lt 1000000000000000 ] 2>/dev/null && { echo "WETH flushed" >>"$LOG"; break; }
  docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/liquidate_to_usdso.py >>"$LOG" 2>&1
  sleep 4
done

# relaunch maker FLAT on WETH at $18 (re-anchors to current price)
docker exec -d dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso PROFIT_LEG_USD=18 PROFIT_POLL_S=5 PROFIT_REQUOTE_S=120 PROFIT_DRIFT_TICKS=2 python3 /app/profit_maker.py >/tmp/maker.log 2>&1'
sleep 2

# re-enable keepalive
( crontab -l 2>/dev/null; echo "*/5 * * * * $DIR/maker_keepalive.sh" ) | crontab -
echo "=== $(date -u +%FT%TZ) reset_maker_weth done ===" >>"$LOG"
