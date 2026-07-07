#!/bin/bash
# stop_and_recover.sh — halt the (failing) taker burst and convert the stranded
# WETH back to USDso to secure the capital. Does NOT relaunch anything.
# Detached so a flaky SSH/Tailscale drop can't half-finish it.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/stop_and_recover.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
WETH=0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8
echo "=== $(date -u +%FT%TZ) stop_and_recover start ===" >>"$LOG"

# 1) remove burst keepalive so nothing relaunches the burst
crontab -l 2>/dev/null | grep -v 'burst_keepalive' | crontab -

# 2) kill the burst
pkill -9 -f direct_burst.py 2>>"$LOG"
sleep 4

# 3) liquidate stranded WETH -> USDso, retry until WETH is dust (<0.001) or 5 tries
wbal() { docker exec dreamdex-agent python3 -c "from web3 import Web3; w3=Web3(Web3.HTTPProvider('https://api.infra.mainnet.somnia.network/',request_kwargs={'timeout':10})); abi=[{'name':'balanceOf','type':'function','stateMutability':'view','inputs':[{'name':'a','type':'address'}],'outputs':[{'name':'','type':'uint256'}]}]; print(w3.eth.contract(address=Web3.to_checksum_address('$WETH'),abi=abi).functions.balanceOf(Web3.to_checksum_address('$H')).call())"; }
for i in 1 2 3 4 5; do
  B=$(wbal 2>>"$LOG"); echo "$(date -u +%FT%TZ) try $i: WETH raw=$B" >>"$LOG"
  [ -n "$B" ] && [ "$B" -lt 1000000000000000 ] 2>/dev/null && { echo "WETH recovered to USDso" >>"$LOG"; break; }
  docker exec -e DREAMDEX_ENV=mainnet dreamdex-agent python3 /app/liquidate_to_usdso.py >>"$LOG" 2>&1
  sleep 4
done

# 4) final balances
docker exec dreamdex-agent python3 -c "
from web3 import Web3
from config import SOMNIA_RPC, MARKETS
w3=Web3(Web3.HTTPProvider(SOMNIA_RPC))
A='$H'
q=Web3.to_checksum_address(MARKETS['WETH:USDso']['quote']); b=Web3.to_checksum_address(MARKETS['WETH:USDso']['base'])
E=[{'name':'balanceOf','type':'function','stateMutability':'view','inputs':[{'name':'a','type':'address'}],'outputs':[{'name':'','type':'uint256'}]}]
print('FINAL USDso',round(w3.eth.contract(address=q,abi=E).functions.balanceOf(Web3.to_checksum_address(A)).call()/1e18,3),'WETH',round(w3.eth.contract(address=b,abi=E).functions.balanceOf(Web3.to_checksum_address(A)).call()/1e18,5),'SOMI',round(w3.eth.get_balance(Web3.to_checksum_address(A))/1e18,3))
" >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) stop_and_recover done ===" >>"$LOG"
