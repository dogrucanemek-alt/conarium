# Per-user identity — local pack (Hetzner stays untouched)

Today a shared token writes `assurance: shared-token` and names nobody.
The code for `policy.profiles` / `policy.actorProfiles` is already in
`src/governance.ts`. This directory is the operator kit to turn it on
**locally**, prove it, and roll it back. Copying to `/opt/conarium-mcp`
is a separate patron decision.

## 1. Mint tokens (hash only on disk)

```bash
node examples/per-user-identity/mint-token.mjs --id emekcan --file ./conarium.tokens.json
node examples/per-user-identity/mint-token.mjs --id copilot --file ./conarium.tokens.json
```

Stdout prints the raw token **once**. The file stores `{ sha256, id }` only.
POSIX mode `0600`. Point the gateway at it:

```bash
export CONARIUM_TOKENS_FILE=$PWD/conarium.tokens.json
```

Do not commit `conarium.tokens.json` or the raw tokens.

## 2. Config overlay (c2)

Merge `policy.overlay.json` under `policy` of the live c2
config. Do **not** replace `allowTables` / connectors.

- Base (AI / unlisted actor): names stay masked.
- `emekcan` → profile `patron`: name columns visible; email / TCKN / IBAN
  scanners still run (a profile cannot switch those off).

Backup first:

```bash
cp conarium.config.c2.json conarium.config.c2.json.bak
```

## 3. Local proof (this machine, not Hetzner)

```bash
npm run build
node examples/per-user-identity/prove-identity.mjs
```

Same row, two tokens: patron sees the name, the other sees `[MASKED_PII]`.
Both receipts carry `assurance: per-user-token`. The patron receipt's
`policy.id` is `conarium.policy/patron`; the other stays `conarium.policy`.
`conarium-verify` must exit 0.

## 4. Rollback (one command)

```bash
# POSIX
cp conarium.config.c2.json.bak conarium.config.c2.json && unset CONARIUM_TOKENS_FILE

# Windows PowerShell
Copy-Item conarium.config.c2.json.bak conarium.config.c2.json -Force; Remove-Item Env:CONARIUM_TOKENS_FILE -ErrorAction SilentlyContinue
```

Leave the tokens file in place or delete it; without `CONARIUM_TOKENS_FILE`
every caller is `shared-token` again. No Hetzner restart is part of this pack.
