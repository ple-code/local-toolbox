#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/apps/local-toolbox"

if [[ -f .local-toolbox/server.pid ]]; then
  pid="$(cat .local-toolbox/server.pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "local-toolbox stopped: $pid"
  fi
  rm -f .local-toolbox/server.pid
fi

for pid in $(pgrep -x node || true); do
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmd" == *"./server.mjs"* ]]; then
    kill "$pid" || true
    echo "local-toolbox stopped stray node: $pid"
  fi
done
