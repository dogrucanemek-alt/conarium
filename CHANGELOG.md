# Changelog

## Unreleased

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
