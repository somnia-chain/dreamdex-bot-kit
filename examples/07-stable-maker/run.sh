#!/usr/bin/env bash
# Production supervisor: keeps mm_bot.py running 24/7, auto-restarting if it
# ever crashes. Logs to bot.log. Use ./stop.sh to stop.
#
#   ./run.sh                 # defaults (size 12, interval 2s)
#   SIZE=15 INTERVAL=2 ./run.sh
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./env.sh >/dev/null 2>&1

SIZE="${SIZE:-15}"
INTERVAL="${INTERVAL:-1}"
EDGE="${EDGE:-1}"
MAXBASE="${MAXBASE:-44}"
CHURN="${CHURN:-0}"          # set CHURN=1 to actively cross for max volume (spends capital)

if [ -z "${DREAMDEX_PRIVATE_KEY:-}" ] && [ -z "${DREAMDEX_PASSWORD:-}" ]; then
  echo "No key loaded — put it in .env first."; exit 1
fi

echo $$ > bot.supervisor.pid
echo "[run] supervisor pid $$ — bot logs -> bot.log (size=$SIZE interval=$INTERVAL)"
trap 'echo "[run] stopping"; pkill -P $$ -f mm_bot.py 2>/dev/null; rm -f bot.supervisor.pid; exit 0' INT TERM

while true; do
  echo "[run] $(date '+%H:%M:%S') starting mm_bot.py" | tee -a bot.log
  CHURN_FLAG=""; [ "$CHURN" = "1" ] && CHURN_FLAG="--churn"
  python3 mm_bot.py --size "$SIZE" --interval "$INTERVAL" \
    --edge-ticks "$EDGE" --max-base "$MAXBASE" $CHURN_FLAG
  code=$?
  echo "[run] $(date '+%H:%M:%S') bot exited code=$code" | tee -a bot.log
  # code 0 = clean shutdown (Ctrl-C/stop) -> don't restart
  [ "$code" -eq 0 ] && break
  echo "[run] restarting in 5s..." | tee -a bot.log
  sleep 5
done
rm -f bot.supervisor.pid
