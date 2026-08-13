#!/usr/bin/env bash
# Restore c2 policy to the backup taken before the identity overlay.
# Does not touch Hetzner. Run from the directory that holds the config.
set -euo pipefail
test -f conarium.config.c2.json.bak || { echo "missing conarium.config.c2.json.bak"; exit 1; }
cp conarium.config.c2.json.bak conarium.config.c2.json
unset CONARIUM_TOKENS_FILE || true
echo "restored conarium.config.c2.json from .bak; CONARIUM_TOKENS_FILE unset"
