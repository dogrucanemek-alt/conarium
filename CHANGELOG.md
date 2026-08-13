# Changelog

## Unreleased

Nothing yet — 0.2.1 is the current cut.

## 0.2.1 — 2026-08-13

Two silent failures: a first run that told you to run a command that fails, and
a gateway that stopped governing without saying so.

### Fixed

- **The published tarball contained a private key, and the README in the same
  tarball said it did not.** `test-vectors/keys/vector-key.SECRET-TEST-ONLY.pem`
  is a throwaway Ed25519 key with no authority over anything — it signs the
  conformance vectors and nothing else. Git excludes it; npm did not, because a
  `files` allowlist overrides `.gitignore`. So 0.2.0 shipped a `BEGIN PRIVATE
  KEY` while `test-vectors/README.md` promised the private half is never
  published. The security impact is nil and the honesty impact is not: verify
  what you ship, not what you meant to ship. The package now excludes every
  `*.pem` that is not a `*.pub.pem`, and a test asserts it on the real
  `npm pack` output.

- **`conarium-init --out <dir>` printed a next step that fails.** The config
  goes to `<dir>`, but the printed command was `conarium-doctor --no-net`, and
  the doctor looks in the working directory. First run ended in a red FAIL.
  Both the printed command and the MCP client block now carry `--config <path>`.
- **The MCP client block started an ungoverned gateway.** It emitted
  `args: [dist/index.js]` with no config path. An MCP client starts the server
  in *its own* working directory, not your install directory; with no config
  found, the gateway does not fail — it comes up with zero connectors and
  governs nothing, quietly. This was true with or without `--out`.
- **A restarted remote gateway lost its client permanently.** A client
  returning with a session id from before the restart got
  `400 expected initialize` as `text/plain`. MCP clients expect JSON-RPC, so the
  reason never reached the user — one proxy reported only "Invalid content from
  server". An unknown session is now `404` with a JSON-RPC body telling the
  client to send a new initialize, and every error response
  (401/403/404/429/400/500) is `application/json`. A plain-text error is an
  undiagnosable error.

## 0.2.0 — 2026-08-13

The governance console was in the package and unreachable. Now it starts.

### Added

- **`conarium-console`** — starts the console over the policy file. It binds
  `127.0.0.1`, refuses to run without `CONARIUM_CONSOLE_TOKEN`, and refuses a
  non-loopback bind unless `CONARIUM_CONSOLE_PUBLIC=1` says you meant it. A
  policy editor reachable from the network is a different threat model than a
  policy editor on your own machine, and the difference should be a decision,
  not a default.

### Fixed

- **The console shipped but nothing could start it.** No bin entry, and the
  gateway never launched it. It has been listed on the pricing page since the
  tiers were written; installed users had exactly one way to change what gets
  masked — editing `conarium.config.json` by hand.
- **It edited the wrong file.** `startConsole()` defaults to the config bundled
  inside the package, which for an installed user is wrong twice: it is not the
  file the gateway reads, and `npm i` overwrites it. The command now defaults to
  `conarium.config.json` in the working directory — the same file the gateway
  loads — and takes `--config`.
- **The UI did not ship.** `public/` was missing from the `files` allowlist, so
  the installed package served `404` at `/`. That was an omission in the 0.1.0
  packaging change.

### Known limits — read before believing the pricing page

The console today edits **`allowTools`, `denyTools` and `maxRows`**. It does
**not** edit `maskColumns`, `allowTables` or `denyTables`, and it has no UI for
per-consumer profiles. Those remain hand-edited in `conarium.config.json`. The
column and table rules are the ones that decide what an assistant can see, so
this is the gap that matters; it is named here rather than left for a buyer to
discover.

## 0.1.2 — 2026-08-13

Patch. `conarium-doctor` aborted instead of exiting when a connector was
unreachable.

### Fixed

- **The documented exit contract (`0` clean / `1` problems / `2` could not run)
  was not honoured on the network path.** The TCP probe resolved on the socket's
  `error` event and the process then exited while the handle was still closing;
  on Windows libuv asserted (`UV_HANDLE_CLOSING`) and the run ended with **127**
  — a code this tool does not define, printed under an assertion trace. Anything
  gating a deployment on the exit status could not read it. Reproduced 3/3 with
  a refused connection; `--no-net` was never affected.

  The probe now resolves after the socket has actually closed, and the tool sets
  `process.exitCode` instead of calling `process.exit()`, so the loop drains on
  its own. A regression test pins it: an unreachable connector must exit `1` and
  the output must not contain an assertion.

## 0.1.1 — 2026-08-13

Patch. The shipped MCP examples told you to run a command that cannot run.

### Fixed

- **`examples/cursor-mcp-settings.json` and `examples/claude-desktop-config.json`
  proposed `npx -y @conarium-ai/core`, which fails with `could not determine
  executable to run`.** The package ships eight commands and none of them is
  named `core`, so npx has nothing to pick. Anyone who pasted the example into
  Cursor or Claude Desktop hit a wall on their first attempt — the worst possible
  moment. The working form, measured rather than assumed:

  ```json
  { "command": "npx",
    "args": ["-y", "--package=@conarium-ai/core", "conarium",
             "--config", "/path/to/your/conarium.config.json"] }
  ```

- The README MCP client block said `"command": "node", "args": ["dist/index.js"]`
  — the from-source path, wrong for anyone who installed the package.

### Changed

- README Quick Start leads with the npm install path now that the package is
  published; the from-source route is kept, folded into a `<details>`.

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
