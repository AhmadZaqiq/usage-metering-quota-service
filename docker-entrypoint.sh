#!/bin/sh
# Repair /run/secrets ownership (the named volume may be root-owned from an
# earlier image), then drop privileges to the unprivileged `node` user before
# running the real command. Root is used only for the chown; the process that
# serves traffic always runs as `node`.
set -eu

SECRETS_DIR=/run/secrets
if [ -d "$SECRETS_DIR" ]; then
  chown node:node "$SECRETS_DIR"
  # 700: only the app user (and root) may read/write the key directory.
  chmod 700 "$SECRETS_DIR"
  if [ -f "$SECRETS_DIR/api-key" ]; then
    chown node:node "$SECRETS_DIR/api-key"
    chmod 600 "$SECRETS_DIR/api-key"
  fi
fi

# Drop to `node` before running the command. node:22-alpine ships busybox `su`,
# which performs the uid/gid switch (it does not ship su-exec, gosu, or a
# util-linux setpriv with --reuid).
#
# BusyBox `su` cannot forward a trailing argv vector: it consumes everything
# after the user name as its own flags (`su node -s /bin/sh script a b -u x`
# fails with `su: unrecognized option: u`). It only runs `su USER -c CMD` when
# CMD is a single token. Both entrypoint forms must survive — the app's
# `sh -c "a && b && c"` (one token) and the client's
# `node script.js -u URL ...` (a multi-word vector) — so the command is
# serialized into one safely single-quoted string and passed via `-c`.
join_cmd() {
  out=
  for a in "$@"; do
    q=$(printf '%s' "$a" | sed "s/'/'\\\\''/g")
    out="$out'$q' "
  done
  printf '%s' "$out"
}

exec su node -s /bin/sh -c "$(join_cmd "$@")" entrypoint
