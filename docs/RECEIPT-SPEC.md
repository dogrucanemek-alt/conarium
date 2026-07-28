# Conarium Receipt Spec v0.1

Public specification for **verifiable access receipts**. Implements the portable
side of EU AI Act Articles 12 (logging) and 19 (content of logs) for Conarium's
governed MCP gateway.

Design source: `docs/superpowers/specs/2026-07-29-conarium-receipt-design.md`.

## Official claim (do not widen)

> A Conarium Receipt proves that records have **not been altered, deleted,
> reordered, or backdated after they were created**. It does **not** prove they
> were correct at the moment of creation.

*(TR)* Conarium Makbuzu, kayıtların **oluşturulduktan sonra değiştirilmediğini,
silinmediğini, yeniden sıralanmadığını ve geriye dönük tarihlenmediğini**
kanıtlar. **Oluşturma anında doğru olduğunu kanıtlamaz.**

## Schema

Version string: `conarium-receipt/0.1`

| Field | Art. 19 role | Notes |
|---|---|---|
| `ts`, `period` | timestamp / usage period | ISO-8601 |
| `model` | model identification | provider / name / version |
| `dataRefs` | reference databases consulted | source + object + field *names* only |
| `policy` | applied governance | decision + rule ids |
| `flags` | triggered policy flags | strings |
| `masking` | counts by class | never raw values |
| `request.argsHash` | request fingerprint | `sha256:…` of args — not the query text |
| `consentRef` | reserved | always `null` in v0.1 |
| `chain.seq` | coverage backbone | contiguous integer; required even before v0.2 coverage proofs |
| `chain.prevHash` / `chain.hash` | integrity | JCS (RFC 8785 subset) → SHA-256 |
| `sig` | Ed25519 over `chain.hash` | `{ alg, keyId, value }` |
| `anchor` | transparency-log head | filled asynchronously; may be `null` |

`hash = sha256(canonicalize(receipt \ {hash, sig, anchor}))` with `chain.hash`
stripped before hashing. Prefix: `sha256:` + hex.

Raw data **never** enters a field — only numbers, class names, and hashes.

## Verifier

```
conarium-verify <file|dir> --pubkey <path> [--pubkey <path2>] [--anchor-check] [--expect-seq-from N] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | Chain intact, signatures valid |
| 10 | Hash mismatch — record altered |
| 11 | `prevHash` break — deleted or inserted |
| 12 | `seq` gap / non-increasing — missing or reordered |
| 13 | Signature invalid / pubkey missing (fail-closed) |
| 14 | Anchor missing/invalid under `--anchor-check` |
| 20 | Schema invalid |

Fail-closed: if the verifier is unsure, it does not exit 0.

## Known gaps (documented, not hidden)

1. **`actor` is a service identity in v0.1**, not a natural person. Per-user OAuth is Layer 2. Until then, marketing must not claim "who accessed".
2. **No bypass detection.** Disabling Conarium and reading the DB directly produces no receipt; the chain still looks healthy. Coverage proofs (v0.2) partially address this against a declared schema.
3. **Creation-time truth is not proven.** Without hardware attestation, an operator can still write false-but-well-formed receipts *before* anchoring.
4. **In-file `sig` stripping + HMAC/`anchor` reduction.** Content `hash` is computed with `{hash, sig, anchor}` (and audit `signature`/`sig`) excluded, so an operator who controls the file can drop or thin those fields without invalidating the content hash itself. Contiguity and the trust store catch some boot-time cases, but full protection against in-file strip/reduce games is **not solvable in-file** (*in-file çözülemez*) — it needs an external transparency-log anchor and/or out-of-band key ceremony. **Mitigation available today, measured:** keep `CONARIUM_AUDIT_HMAC_KEY` enabled alongside Ed25519. HMAC is keyed, so an actor who strips `sig` and recomputes the unkeyed hashes still fails the HMAC check (`entry signature mismatch`). Verified by test: Ed25519 alone → strip-all passes the boot check; Ed25519 + HMAC → caught. `conarium-verify --pubkey` also catches it (exit 13, `missing sig`) because it is told to expect signatures.
5. **`argsHash` hurts debugging.** Support cases need the customer's own logs to correlate.

## Key material

- Algorithm: Ed25519 (Node `crypto`, no extra dependency)
- Private key path: `CONARIUM_AUDIT_SIGNING_KEY`
- `keyId` sidecar: `<pem-path>.keyid` (UTF-8 single line), or `CONARIUM_AUDIT_KEY_ID`
- Trust store (rotation): `CONARIUM_AUDIT_TRUST_PUBKEYS` — comma/semicolon-separated
  public PEM paths (each with `.keyid`). Current signing pubkey is always included.
- Contiguity: after the first audit line that carries `sig`, every later line must
  also carry `sig` (absence → corrupt). Foreign `keyId` OK if in the trust store.
- HMAC (`CONARIUM_AUDIT_HMAC_KEY` → audit `signature` field) remains for backwards compatibility with `scripts/audit-chain-check.mjs`
- No signing key and no `CONARIUM_AUDIT_UNSIGNED=1` → production refuses to write (fail-closed)
