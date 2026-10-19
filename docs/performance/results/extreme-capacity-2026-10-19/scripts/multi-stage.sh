#!/usr/bin/env bash
# Run one parallel multi-target load stage (one child process per account).
# Campaign-only helper (untracked).
#
# Usage:
#   ./multi-stage.sh <label> <connectionsPerAccount> <durationSec> <key1,key2,...> [user1,user2,...]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="$1"
CONN_PER="$2"
DUR="$3"
KEYS="$4"
USERS="${5:-}"

echo "$LABEL" > "$ROOT/snapshots/current-stage.txt"
node "$ROOT/scripts/db-state.mjs" --out "$ROOT/snapshots/state-before-$LABEL.json" > /dev/null

ARGS=(
  --label "$LABEL"
  --accounts "$KEYS"
  --connections-per "$CONN_PER"
  --duration "$DUR"
  --out "$ROOT/raw/$LABEL.json"
)
if [ -n "$USERS" ]; then
  ARGS+=(--users "$USERS")
fi

node "$ROOT/scripts/run-multi.mjs" "${ARGS[@]}" | tee "$ROOT/raw/$LABEL.txt"

node "$ROOT/scripts/db-state.mjs" --out "$ROOT/snapshots/state-after-$LABEL.json" > /dev/null
echo "-" > "$ROOT/snapshots/current-stage.txt"
