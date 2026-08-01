#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/apps/local-toolbox"

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-5187}"
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-/run/user/1000/gdm/Xauthority}"
export CHROME_PATH="${CHROME_PATH:-$HOME/apps/google-chrome-stable/opt/google/chrome/google-chrome}"
export LOCAL_TOOLBOX_DATA_DIR="${LOCAL_TOOLBOX_DATA_DIR:-$HOME/apps/local-toolbox/.local-toolbox}"

exec npm start
