#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/apps/local-toolbox"
mkdir -p .local-toolbox

if [[ -f .local-toolbox/server.pid ]]; then
  old_pid="$(cat .local-toolbox/server.pid)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "local-toolbox already running: $old_pid"
    exit 0
  fi
fi

nohup ./run-e540.sh > local-toolbox.log 2>&1 < /dev/null &
echo "$!" > .local-toolbox/server.pid
echo "local-toolbox started: $(cat .local-toolbox/server.pid)"
