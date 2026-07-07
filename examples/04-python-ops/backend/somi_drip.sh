#!/bin/sh
# Drip-sell a little SOMI -> USDso on a 15-min cron, so the daily SOMI->capital
# conversion looks like organic trading instead of one big visible blob.
# - Randomized small size (1.05-1.50 SOMI) per tick: above the pool minQty of
#   1.0 SOMI, but far smaller/organic than one big blob.
# - KEEP_SOMI floor leaves the maker its gas reserve; below it sell_somi no-ops.
# - A nonce clash with the maker just fails this tick harmlessly (no double-sell).
AMT=$(awk 'BEGIN{srand(); printf "%.2f", 1.05 + rand()*0.45}')
TS=$(date -u +%FT%TZ)
echo "[$TS] drip sell $AMT SOMI (KEEP_SOMI=2.5)" >> /tmp/somi_drip.log
docker exec -e KEEP_SOMI=2.5 dreamdex-agent python3 /app/sell_somi.py "$AMT" >> /tmp/somi_drip.log 2>&1
echo "[$TS] ---" >> /tmp/somi_drip.log
