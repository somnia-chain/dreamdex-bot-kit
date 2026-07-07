#!/bin/bash
# cycle_phase.sh {burst|maker} — switch wallet H between the two WORKING volume
# engines and flip their keepalive crons so they never fight.
#   burst = aware_burst_vault.py  (IOC taker via placeOrder, slip=200, ~100% fill;
#           round-trips buy+sell, bleeds spread toll but makes volume FAST)
#   maker = profit_maker.py       (wallet-funded PostOnly round-trips, no-bleed,
#           inventory-aware: sells WETH the burst left behind)
# Cron alternates these every 2h; the per-phase keepalive keeps the active engine
# alive between switches. Detached-safe.
set -u
DIR=/home/irony/dreamdex-agent
LOG="$DIR/logs/cycle_phase.log"
H=0xF4c825F3C2970153d78B407CF190861dd4E2b905
MODE="${1:-maker}"
echo "=== $(date -u +%FT%TZ) cycle_phase -> $MODE ===" >>"$LOG"

kill_engines() {
  docker exec dreamdex-agent sh -c 'for p in /proc/[0-9]*; do read c < "$p/comm" 2>/dev/null||continue; case "$c" in python*) grep -qaE "aware_burst_vault|profit_maker" "$p/cmdline" 2>/dev/null && kill "${p##*/}";; esac; done' 2>>"$LOG"
  sleep 4
}

if [ "$MODE" = "burst" ]; then
  # keepalive: vault-taker on, maker off
  ( crontab -l 2>/dev/null | grep -v -E 'maker_keepalive|aware_vault_keepalive'; echo "*/3 * * * * $DIR/aware_vault_keepalive.sh" ) | crontab -
  kill_engines
  # cancel any resting maker order so its WETH/USDso is free for the burst
  docker exec dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso python3 /app/profit_maker.py --shutdown' >>"$LOG" 2>&1
  sleep 3
  docker cp "$DIR/aware_burst_vault.py" dreamdex-agent:/app/aware_burst_vault.py 2>>"$LOG"
  docker exec -d dreamdex-agent sh -c 'BURST_PAIR=WETH:USDso BURST_USDSO=20 BURST_SLIPPAGE_TICKS=200 BURST_SOMI_GAS_RESERVE=0.2 BURST_CYCLES=99999 BURST_SELL_RETRIES=8 BURST_FUNDING=wallet python3 /app/aware_burst_vault.py > /tmp/avault.log 2>&1'
  echo "$(date -u +%FT%TZ) burst phase started" >>"$LOG"
else
  # keepalive: maker on, vault-taker off
  ( crontab -l 2>/dev/null | grep -v -E 'maker_keepalive|aware_vault_keepalive'; echo "*/5 * * * * $DIR/maker_keepalive.sh" ) | crontab -
  kill_engines
  # maker starts inventory-aware: sells the burst's accumulated WETH via PostOnly
  # sells and round-trips, recovering USDso for the next burst phase.
  docker cp "$DIR/profit_maker.py" dreamdex-agent:/app/profit_maker.py 2>>"$LOG"
  docker exec -d dreamdex-agent sh -c 'PROFIT_PRIVATE_KEY="$MAINNET_PRIVATE_KEY" PROFIT_ADDRESS='"$H"' PROFIT_PAIR=WETH:USDso PROFIT_FUNDING=wallet PROFIT_LEG_USD=8 PROFIT_GAS_RESERVE_SOMI=0.1 PROFIT_MARGIN_TICKS=3 PROFIT_POLL_S=5 PROFIT_REQUOTE_S=120 PROFIT_DRIFT_TICKS=2 python3 /app/profit_maker.py > /tmp/maker.log 2>&1'
  echo "$(date -u +%FT%TZ) maker phase started" >>"$LOG"
fi
echo "=== $(date -u +%FT%TZ) cycle_phase $MODE done ===" >>"$LOG"
