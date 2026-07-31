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

1. **`actor` is a service identity unless per-user tokens are configured.** With a token file (`CONARIUM_TOKENS_FILE`, default `conarium.tokens.json`), the audit line and the receipt name the individual and set `assurance: "per-user-token"`. Without it the actor is the connecting service, with `assurance: "shared-token"`. This is an operator-managed token map — **not** OAuth or SSO; there is no identity-provider integration, so the assurance is only as good as the operator's token hygiene. For shared-token deployments, marketing must not claim "who accessed".
2. **No bypass detection — partially addressed as of coverage v0.2.** Disabling Conarium and reading the DB directly still produces no receipt. What coverage proofs add is that *absence becomes checkable*: `conarium-coverage` emits a signed declaration over a period and the declared scope (`policy.allowTables`), asserting whether the receipt chain is contiguous (and naming the gap if not), and listing which declared objects have recorded access and which do not. **The declaration says "access NOT RECORDED", never "no access occurred"** — an absent record is ambiguous by nature: the access may not have happened, Conarium may have been bypassed, or logging may have failed. Receipts whose object cannot be determined are counted in `unassignedReceiptCount` and the verifier warns that the `notRecorded` list is not definitive while that count is above zero. Full bypass detection needs reconciliation against the data source's own logs (e.g. `pg_stat_statements`) — not implemented.
3. **Creation-time truth is not proven.** Without hardware attestation, an operator can still write false-but-well-formed receipts *before* anchoring.
4. **In-file `sig` stripping + HMAC/`anchor` reduction.** Content `hash` is computed with `{hash, sig, anchor}` (and audit `signature`/`sig`) excluded, so an operator who controls the file can drop or thin those fields without invalidating the content hash itself. Contiguity and the trust store catch some boot-time cases, but full protection against in-file strip/reduce games is **not solvable in-file** (*in-file çözülemez*) — it needs an external transparency-log anchor and/or out-of-band key ceremony. **Mitigation available today, measured:** keep `CONARIUM_AUDIT_HMAC_KEY` enabled alongside Ed25519. HMAC is keyed, so an actor who strips `sig` and recomputes the unkeyed hashes still fails the HMAC check (`entry signature mismatch`). Verified by test: Ed25519 alone → strip-all passes the boot check; Ed25519 + HMAC → caught. `conarium-verify --pubkey` also catches it (exit 13, `missing sig`) because it is told to expect signatures. **Anchor is available** (`CONARIUM_ANCHOR_SINK=opentimestamps`) but starts as `pending` — Bitcoin finality is delayed (hours); see §Anchoring.
5. **`argsHash` hurts debugging.** Support cases need the customer's own logs to correlate.

## Anchoring (OpenTimestamps)

Chain-head hashes are optionally stamped with **OpenTimestamps** (opt-in:
`CONARIUM_ANCHOR_SINK=opentimestamps`). Only the raw 32-byte digest is sent
(our `sha256:<hex>` prefix is stripped first). Proofs live in a sidecar
`<sink>.anchors.jsonl`; the receipt’s `anchor` field is a hash-exterior
reference: `{ "log": "opentimestamps", "ref": "sha256:…", "state": "pending"|"bitcoin" }`.

| State | Meaning |
|---|---|
| `pending` | Calendar attestation only — **not yet** Bitcoin-confirmed (hours). |
| `bitcoin` | Upgraded via `conarium-anchor-upgrade`; Bitcoin block height recorded. |

**Why not Sigstore Rekor?** `hashedrekord` does not accept plain Ed25519 the way
we sign (it digests internally / wants the original artifact); the `rekord` type
uploads content — which we refuse. Public Rekor is also aimed at software supply
chain, not hash calendars.

**RFC3161 TSA:** deferred. `AnchorSink` stays pluggable for a later TSA
implementation; institutional buyers may prefer it, but it requires trusting a TSA.

**Honest latency:** “not backdated” becomes Bitcoin-hard only after upgrade. Pending
is disclosed — `conarium-verify --anchor-check` exits 0 with a stderr warning while
pending, and exits 14 if the proof is missing or does not match the hash.

**Manual dogfood — done 31 July 2026.** A real stamp was submitted, not simulated.
The proof is committed at `docs/dogfood/2026-07-31-anchor.anchors.jsonl` so anyone can
re-verify it, or upgrade it themselves with `conarium-anchor-upgrade`.

| | |
|---|---|
| Submitted hash | `sha256:6b32ebdf4e6674b6187155a81c2b25fb71e93b5a2691d106f0cd7b5d01f2affd` |
| Calendars reached | `a.pool.opentimestamps.org`, `b.pool.opentimestamps.org`, `a.pool.eternitywall.com`, `ots.btc.catallaxy.com` |
| Submit latency | 2.08 s |
| `.ots` proof size | **980 bytes** |
| State | `bitcoin` |
| Upgraded block | **960327** (upgraded 2026-07-31T09:20:23Z) |

The stamp was born `pending` and stayed that way for about ten hours, which is the
honest part: Bitcoin finality takes hours, so a stamp cannot be born confirmed. During
that window backdating resistance was calendar-grade, not Bitcoin-hard — exactly what
§Anchoring says. `npx conarium-anchor-upgrade docs/dogfood/2026-07-31-anchor.anchors.jsonl`
then collected attestations from three of the four calendars (eternitywall timed out;
three are sufficient) and wrote the block height above. From this point the claim
"these records were not created after block 960327" is verifiable by anyone, against
Bitcoin, without trusting us.

What this dogfood does and does not establish: it establishes that the anchoring path
works end to end against the real OpenTimestamps network and that the sidecar carries
only `{seq, hash, log, ots, state, submittedAt, upgradedAt, bitcoinBlock}` — no query,
no rows, no PII. It does not establish Bitcoin finality yet.

Known gap #4 note: an external OTS anchor is the out-of-file mitigation for
in-file `sig`/HMAC/`anchor` stripping; while `state` is `pending`, backdating
resistance is calendar-grade, not Bitcoin-final.

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
