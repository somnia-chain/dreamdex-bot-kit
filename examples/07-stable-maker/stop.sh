#!/usr/bin/env bash
# Stop the bot + supervisor cleanly (cancels open orders via the bot's own
# shutdown handler, then kills the supervisor).
cd "$(dirname "$0")"
echo "[stop] signalling bot + supervisor..."
pkill -INT -f "python3 mm_bot.py" 2>/dev/null && echo "[stop] sent INT to mm_bot.py"
if [ -f bot.supervisor.pid ]; then
  kill -TERM "$(cat bot.supervisor.pid)" 2>/dev/null && echo "[stop] stopped supervisor"
  rm -f bot.supervisor.pid
fi
sleep 8
# Belt-and-suspenders: cancel any orders still open.
# shellcheck disable=SC1091
source ./env.sh >/dev/null 2>&1
ids=$(dreamdex order list "USDC.e:USDso" --status open --json 2>/dev/null \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print('\n'.join(o['id'] for o in (d.get('orders') or [])))" 2>/dev/null)
for id in $ids; do
  echo "[stop] cancelling leftover $id"
  dreamdex order cancel "USDC.e:USDso" "$id" >/dev/null 2>&1
done
echo "[stop] done. Vault:"
dreamdex vault balance "USDC.e:USDso" --json 2>/dev/null
