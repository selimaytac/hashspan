#!/usr/bin/env bash
# Runs the example agent against a fresh local Anvil chain, then stops the chain. Used by `make demo`.
# Fails instead of reusing whatever already listens on the port, so the demo always starts from a known state.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ANVIL="${DEMO_ANVIL:-$root/.tools/bin/anvil}"
PORT="${DEMO_PORT:-8545}"
READY_TIMEOUT="${DEMO_READY_TIMEOUT:-20}"
# Split on spaces, without shell quoting or globbing rules; meant for tests.
DEMO_CMD="${DEMO_CMD:-pnpm demo}"

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

if listening; then
  echo "demo: port $PORT is already in use; stop the process listening on it (for example a running 'make anvil')" >&2
  exit 1
fi

"$ANVIL" --host 127.0.0.1 --port "$PORT" --silent &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

deadline=$((SECONDS + READY_TIMEOUT))
until listening; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "demo: Anvil exited before it was ready" >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "demo: Anvil was not ready after $READY_TIMEOUT s" >&2
    exit 1
  fi
  sleep 0.2
done

RPC_URL="http://127.0.0.1:$PORT" $DEMO_CMD
