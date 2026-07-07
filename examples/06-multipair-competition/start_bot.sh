#!/usr/bin/env bash
# Detached launcher for the DreamDEX bot.
# Uses a Python double-fork + setsid so the bot runs in its own session and
# survives the parent shell exiting (macOS has no `setsid` binary).
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# Stop any existing instance first.
pkill -f "bot/bot.py" 2>/dev/null || true
sleep 2

python3 - "$ROOT_DIR" <<'PYEOF'
import os, sys
root = sys.argv[1]

# First fork
if os.fork() > 0:
    os._exit(0)
os.setsid()  # new session -> detached from caller's process group
# Second fork so we can never reacquire a controlling terminal
if os.fork() > 0:
    os._exit(0)

# Redirect stdio to the log file
os.chdir(root)
log = open(os.path.join(root, "bot.log"), "a")
devnull = open(os.devnull, "r")
os.dup2(devnull.fileno(), 0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)

# Run inside venv + env via a login-ish bash that sources .env and venv.
script = (
    "cd '%s' && source .venv/bin/activate && set -a && source .env && set +a && "
    "exec caffeinate -i python -u bot/bot.py --config bot/config.yml" % root
)
os.execvp("bash", ["bash", "-c", script])
PYEOF

echo "bot launched (detached)"
