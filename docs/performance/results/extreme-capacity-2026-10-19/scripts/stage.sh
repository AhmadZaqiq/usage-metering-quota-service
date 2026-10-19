#!/usr/bin/env bash
# Run one single-target load stage with warmup and DB-state snapshots.
# Campaign-only helper (untracked).
#
# Usage: ./stage.sh <label> <connections> <durationSec> <apiKey> [userId]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="$1"
CONN="$2"
DUR="$3"
KEY="$4"
USER="${5:-}"

USER_ARGS=()
if [ -n "$USER" ]; then
  USER_ARGS=(--user-id "$USER")
fi

echo "$LABEL" > "$ROOT/snapshots/current-stage.txt"
node "$ROOT/scripts/db-state.mjs" --out "$ROOT/snapshots/state-before-$LABEL.json" > /dev/null

if [ "${SKIP_WARMUP:-0}" != "1" ]; then
  node "$ROOT/scripts/run-stage.mjs" --label "$LABEL-warmup" --connections 5 --duration 3 \
    --key "$KEY" "${USER_ARGS[@]}" --out "$ROOT/raw/$LABEL-warmup.json" > /dev/null 2>&1 || true
fi

node "$ROOT/scripts/run-stage.mjs" --label "$LABEL" --connections "$CONN" --duration "$DUR" \
  --key "$KEY" "${USER_ARGS[@]}" --out "$ROOT/raw/$LABEL.json" | tee "$ROOT/raw/$LABEL.txt"

node "$ROOT/scripts/db-state.mjs" --out "$ROOT/snapshots/state-after-$LABEL.json" > /dev/null
echo "-" > "$ROOT/snapshots/current-stage.txt"
