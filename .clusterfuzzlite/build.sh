#!/bin/bash
set -eu
npm ci
npm run build
mkdir -p "$OUT"
for name in sql-gate receipt-jsonl jcs countersign; do
  cp "fuzz/${name}.fuzz.mjs" "$OUT/${name}.fuzz.mjs"
  if [ -d "fuzz/corpus/${name}" ]; then
    mkdir -p "$OUT/${name}_seed_corpus"
    cp -r "fuzz/corpus/${name}/." "$OUT/${name}_seed_corpus/"
  fi
done
cp -r dist "$OUT/dist"
# A zip per target so ClusterFuzzLite / OSS-Fuzz can find seeds.
if command -v zip >/dev/null 2>&1; then
  for name in sql-gate receipt-jsonl jcs countersign; do
    if [ -d "$OUT/${name}_seed_corpus" ]; then
      (cd "$OUT/${name}_seed_corpus" && zip -q -r "$OUT/${name}_seed_corpus.zip" .)
    fi
  done
fi
