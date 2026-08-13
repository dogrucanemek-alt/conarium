#!/usr/bin/env bash
# c2 — production MCP (HTTP). Secrets live in the env file, never here.
set -euo pipefail
ROOT="${CONARIUM_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"
ENV_FILE="${CONARIUM_ENV_FILE:-.env.c2}"
CONFIG="${CONARIUM_CONFIG:-conarium.config.c2.json}"
test -f "$ENV_FILE" || { echo "missing $ENV_FILE"; exit 1; }
test -f "$CONFIG" || { echo "missing $CONFIG"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec node dist/http.js --config "$CONFIG"
