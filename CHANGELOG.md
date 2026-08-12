# Changelog

## Unreleased

Nothing yet — 0.1.0 is the current cut.

## 0.1.0 — 2026-08-13

First product cut, published to npm as `@conarium-ai/core@0.1.0`.

### Fixed before it shipped — `bin` entries were being stripped

The first publish attempt failed on 2FA, and the failure was lucky. Its output
carried this, once per command:

```
npm warn publish "bin[conarium-doctor]" ... was invalid and removed
```

npm was dropping **all eight** command entries, because the values began with
`./`. Published that way, `npx conarium-doctor` would not have existed — the
whole point of a one-download install. `npm pack` was never affected, so the
tarball looked correct the entire time; what npm rewrote was the metadata sent
to the registry. Fixed with npm's own `npm pkg fix` (`./bin/x.mjs` → `bin/x.mjs`)
and verified against the published package: eight bins present.

**Lesson worth keeping: a correct `npm pack` does not mean a correct
`npm publish`. Read the `warn` lines in `npm publish --dry-run`.**

### Added — install without us in the loop

- `conarium-init` (`bin/conarium-init.mjs`): writes a fail-closed
  `conarium.config.json`, an Ed25519 key pair, and the `.keyid` sidecars the
  verifier needs. Refuses to overwrite without `--force`. Never prints the
  private key. Exit 0/1/2 (outside the receipt exit-code namespace).
- `conarium-doctor` version section: prints the installed version from
  `package.json`. With a network, GETs `registry.npmjs.org/@conarium-ai/core/latest`
  (2s timeout, errors are warnings). `--no-net` makes **zero** requests.
  Telemetry none — the request is a version number, nothing is sent.
- Offline license verifier (`src/license.ts`): JCS + Ed25519, same construction
  as receipts. Missing/invalid/expired → `community`. No feature gates, no
  keygen, no payments.
- `package.json` `files` allowlist: the tarball is `dist`, `bin`, `scripts`,
  `docs`, `examples`, `test-vectors`, `deploy`, plus the license/readme files —
  not CI workflows or the marketing site. `scripts/` is included because
  `conarium-reconcile` references `scripts/pg-snapshot.sql`.
- `deploy/anchor-service/`: systemd unit, pm2 ecosystem, `.env.example`, dry-run
  script. **Deploy itself is not this release.**

### Added — conarium-reconcile v0.1: two-sided coverage (bypass detection)

- New standalone CLI `bin/conarium-reconcile.mjs` (zero imports from `src/`):
  reconciles the database's **own per-role query counters** (reference:
  `pg_stat_statements`, snapshot helper `scripts/pg-snapshot.sql`) against the
  in-window receipts. A DB-recorded query pattern no receipt covers exits 40:
  *access was recorded by the database but not receipted* — gateway bypassed or
  receipt sink failed; the tool states the fact, not the intent.
- Honesty rules carried over from the coverage declaration: per-pattern/per-table
  matching (never per call count — PostgREST fans one request into several
  statements), nothing silently cleared (unattributable patterns fail the run),
  unreliable windows refused (counter regression → exit 20), unassigned receipts
  make findings explicitly non-definitive.
- `test/spec_exitcode_drift.mjs` now guards **all three** CLIs
  (verify / coverage / reconcile) against the RECEIPT-SPEC exit-code tables;
  proven to fail in both directions.
- RECEIPT-SPEC known gap #2 updated: bypass detection is now addressed with
  stated limits (DB counters are trusted, dedicated role required).

### Fixed — HMAC signature contiguity (the HMAC half of F1)

- `validateChain` rejected **unsigned legacy entries** as corrupt whenever an HMAC key was
  present: `entry.signature !== expected` was the only check, so a missing signature failed
  it. Any audit sink written before signing existed became unopenable the moment HMAC was
  configured — the server would not boot. This is the same conflation F1 fixed for Ed25519
  in July (*"cannot be verified with this key"* ≠ *"tampered"*), left open on the HMAC side.
  It hit production on 2026-08-05 and forced HMAC to be disabled, which in turn left the
  install exposed to the strip-all attack that HMAC is the documented mitigation for
  (RECEIPT-SPEC known gap #4).
- Now symmetric with Ed25519: unsigned entries **before** the first signed entry are legacy
  and accepted; an unsigned entry **after** a signed one is a signature-removal attempt and
  is rejected; a present-but-wrong signature is always rejected. Signature *presence* counts
  toward contiguity even without a key, so "drop the key, then strip the signatures" fails.

### Changed — Receipt v0.3: meta provenance

- `model` and `client` now carry a `source` field alongside the value:
  `protocol` (measured from MCP `initialize`), `operator-declared` (declared in config,
  **not** verified by Conarium), or `undeclared` (`null` fields — nothing invented).
- **`audit.receiptModel` / `audit.receiptClient` are no longer required.** Previously,
  configuring `receiptSink` without both fields threw at construction, which kept receipt
  generation permanently off: model identity does not exist in the MCP protocol, so it
  could only ever come from an operator's declaration. Receipts are now emitted and the
  missing field is recorded as `undeclared` instead of being invented.
- Verifier accepts `0.1`, `0.2` and `0.3`; older receipts remain verifiable (regression-locked).
  It reports undeclared counts: `ok: 3 receipt(s) verified (2 with undeclared model)`.
- ⚠️ Ed25519 remains **required** for receipts — this was not relaxed.
- Spec: `docs/superpowers/specs/2026-08-05-receipt-meta-provenance-design.md`

### Added — Receipt v0.1 (verifiable audit receipts)

- Ed25519 key management (`src/keys.ts`) with `.keyid` sidecars
- Portable receipt schema + JCS canonicalize + hash (`src/receipt.ts`)
- Independent offline verifier: `bin/conarium-verify.mjs`
- Transparency-log anchor interface + scheduler (`src/anchor.ts`; Memory sink for tests, Rekor-shaped sink stub)
- Spec: `docs/RECEIPT-SPEC.md`

### Changed

- **BREAKING — Connectors are fail-closed.** `policy.allowConnectors` is
  now a strict allow-list: if it is missing or empty, **no** connector is
  permitted (previously an empty list meant "allow all"). This matches the
  existing default-deny posture of `allowTables` — the product's stated position
  is "Nothing is allowed unless you allow it", and the connector path was the one
  exception that contradicted it. `bootDeps` now refuses to start when connectors
  are configured but `allowConnectors` is empty, naming the missing field and the
  connectors it should list — so an operator blames the changed default, not
  their own policy. **Migration:** add `policy.allowConnectors: ["connector1", "connector2"]`
  to your config (or remove the connectors). `denyConnectors` still takes
  precedence over `allowConnectors`.

- Audit signing is **fail-closed**: without `CONARIUM_AUDIT_HMAC_KEY` or
  `CONARIUM_AUDIT_SIGNING_KEY`, writes throw unless `CONARIUM_AUDIT_UNSIGNED=1`
  is set explicitly (was: silent skip). Capability is checked at **construction**
  as well as `log()` (GATE 1 / F3).
- Audit entries may carry Ed25519 `sig` alongside legacy HMAC `signature`.
- `validateChain` treats missing `sig` / foreign `keyId` as out-of-scope (legacy /
  rotation), not tampering (GATE 1 / F1).

### Added — OpenTimestamps anchoring (Katman 0 / A)

- `OpenTimestampsSink` + sidecar `<sink>.anchors.jsonl` (hash-only; opt-in via
  `CONARIUM_ANCHOR_SINK=opentimestamps`)
- `bin/conarium-anchor-upgrade.mjs` (pending → bitcoin)
- `conarium-verify --anchor-check` verifies OTS against chain head (pending warns)
- Rekor explicitly rejected; RFC3161 deferred — see `docs/RECEIPT-SPEC.md` §Anchoring

### Docs (GATE 2)

- Official claim: English is canonical; Turkish kept as translation (G2-1).
- Known gaps §4: in-file sig stripping + HMAC/anchor reduction — *in-file çözülemez* (G2-2).
- `writeKeyPairFiles` now returns `publicKeyIdPath` (G2-3).

### Fixed (GATE 1 follow-up / F5)

- `validateChain` Ed25519 **contiguity**: after the first signed line, missing
  `sig` is corrupt; foreign `keyId` accepted when present in the trust store.
- Multi-keyId trust store: current signing pubkey + `CONARIUM_AUDIT_TRUST_PUBKEYS`.
- See `docs/superpowers/TODO-gate1-f4.md` (F4 text; implemented as F5).
