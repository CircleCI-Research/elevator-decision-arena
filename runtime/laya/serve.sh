#!/bin/sh
# Start laya-serve for the arena: loopback only, key required, pinned checkpoint.
#
# Keys come from ~/.config/elevator-arena/env (LAYA_API_KEY), never from the repo.
# Setup once:  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python "laya[serve]"
#
# Note: laya-serve has no --help; running it with any arguments starts a server
# bound to 0.0.0.0 with no authentication. Always start it through this script.
set -eu
cd "$(dirname "$0")"
ENV_FILE="${HOME}/.config/elevator-arena/env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (needs LAYA_API_KEY)" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
unset TYPESAFE_API_KEY # the local server has no use for it
[ -n "${LAYA_API_KEY:-}" ] || { echo "LAYA_API_KEY is not set in $ENV_FILE" >&2; exit 1; }
export LAYA_HOST=127.0.0.1 LAYA_PORT="${LAYA_PORT:-8000}" LAYA_MODELS="${LAYA_MODELS:-english}" \
  LAYA_REVISION=reviewed LAYA_DEVICE="${LAYA_DEVICE:-mps}" LAYA_PRELOAD=1 USE_TF=0
exec .venv/bin/laya-serve
