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
  [[ -r "/proc/$pid/cmdline" ]] || continue
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmd" == *"./server.mjs"* ]]; then
    kill "$pid" || true
    echo "local-toolbox stopped stray node: $pid"
  fi
done

if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -t -iTCP:5187 -sTCP:LISTEN 2>/dev/null || true); do
    kill "$pid" || true
    echo "local-toolbox stopped listener: $pid"
  done
fi

for pid in $(pgrep -x chrome || true); do
  [[ -r "/proc/$pid/cmdline" ]] || continue
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmd" == *"--user-data-dir=$HOME/apps/local-toolbox/.chrome-profile"* ]]; then
    kill "$pid" || true
    echo "local-toolbox stopped chrome: $pid"
  fi
done
