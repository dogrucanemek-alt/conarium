# Conarium Receipt Spec

Public specification for **verifiable access receipts**. Schema version
**`conarium-receipt/0.4`** is canonical. The verifier also accepts `0.1`, `0.2`,
and `0.3` forever — published receipts keep their original `v` string; this
document does not change it. A 0.3 receipt is not rewritten, re-hashed, or
re-signed when 0.4 fields appear.

Implements the portable side of EU AI Act Articles 12 (logging) and 19 (content
of logs) for Conarium's governed MCP gateway.

Design source: `docs/superpowers/specs/2026-07-29-conarium-receipt-design.md`.

## Official claim (do not widen)

> A Conarium Receipt proves that the records **still in the file** have not been
> altered, reordered, or backdated after they were created, and that none were
> **removed from the middle** of the chain (`prevHash` / `seq`). It does **not**
> prove they were correct at the moment of creation. It cannot, by itself, prove
> that records were not **dropped from the end**: a shorter leftover chain is
> still internally consistent. Catching tail truncation needs a pin from outside
> the file (`--expect-count`, `--expect-last-hash`, an OpenTimestamps anchor, or
> `conarium-reconcile`).

*(TR)* Conarium Makbuzu, dosyada **hâlâ duran** kayıtların oluşturulduktan sonra
değiştirilmediğini, **ortadan** silinmediğini, yeniden sıralanmadığını ve geriye
dönük tarihlenmediğini kanıtlar. **Oluşturma anında doğru olduğunu kanıtlamaz.**
Sondan kesmeyi tek başına göremez.
*(/TR)*

## Media type

| | |
|---|---|
| Media type | `application/vnd.conarium.receipt+json` |
| Single receipt | `.json` — one JSON object, schema `conarium-receipt/0.4` (verifiers also accept `0.1`–`0.3`) |
| Chain (append-only) | `.jsonl` — one receipt object per line, same schema, `chain.seq` contiguous |

The vendor tree is the stable identifier for tools that switch on type rather
than filename. A `.jsonl` file is still `application/vnd.conarium.receipt+json`
with an outer sequence; there is no separate chain media type.

## Schema

Version string: `conarium-receipt/0.4` (verifier also accepts `0.1`, `0.2`, and `0.3` — forever)

| Field | Art. 19 role | Notes |
|---|---|---|
| `ts`, `period` | timestamp / usage period | ISO-8601 |
| `model` | model identification | `source` + provider / name / version — see **Meta provenance** below |
| `client` | calling client | `source` + name / version |
| `destination` | where the result was sent | `value` + `source` — **0.4**. Operator declaration; Conarium does not verify it. Not a policy input. |
| `dataRefs` | reference databases consulted | source + object + field *names* only |
| `policy` | applied governance | decision + rule ids |
| `flags` | triggered policy flags | strings (`denied`, `protected-column-denied`, …) — free list; schema string unchanged |
| `masking` | counts by class | never raw values |
| `disclosure` | bytes that left | **0.4**. Hash of the masked, row-capped payload that was sent — see **Disclosure** below |
| `request.argsHash` | request fingerprint | `sha256:…` of args — not the query text |
| `consentRef` | reserved | always `null` in `conarium-receipt/0.4` (and in 0.1/0.2/0.3). The field exists so a later schema can fill it without renaming. |
| `chain.seq` | coverage backbone | contiguous integer; required even before v0.2 coverage proofs |
| `chain.prevHash` / `chain.hash` | integrity | JCS (RFC 8785 subset) → SHA-256 |
| `sig` | Ed25519 over `chain.hash` | `{ alg, keyId, value }` |
| `anchor` | transparency-log head | `null` when written; filled only after `conarium-stamp` or `conarium-anchor-service` |

`hash = sha256(canonicalize(receipt \ {hash, sig, anchor}))` with `chain.hash`
stripped before hashing. Prefix: `sha256:` + hex.

Raw data **never** enters a field — only numbers, class names, and hashes.

`flags` is a free string array in `conarium-receipt/0.4` (and in 0.3). A query refused
because a `protectedColumns` pattern appeared in a predicate carries
`protected-column-denied` (and `denied`). The flag is a class name — it does
not carry the column value.

`destination` and `disclosure` are **required on 0.4** and **not required on
0.1/0.2/0.3**. An old receipt is not invalid because those fields are absent.

### Meta provenance (one vocabulary)

`model`, `client`, `destination`, and `disclosure` share **one** `source`
vocabulary. There is no second set (`DECLARED` / `OBSERVED` / `VERIFIED` /
`DERIVED`). There is no `verified` value. If attestation arrives later, the
new value will be `attested` — not a boolean flag left empty today.

A receipt never says *"the model was X"* — it says *"X was declared"* or
*"not declared"*.

| `source` | meaning | Who uses it |
|---|---|---|
| `protocol` | measured during the connection (MCP `initialize` → `clientInfo`) | `model`, `client` |
| `measured` | Conarium computed it (a hash of bytes it held) | `disclosure` |
| `operator-declared` | the operator declared it in config; **Conarium did not verify it** | `model`, `client`, `destination` |
| `undeclared` | not declared — value fields are `null`, nothing was invented | all of the above |

### Disclosure (v0.4)

`request.argsHash` binds the request. It does not bind what left. `disclosure`
binds the **exact UTF-8 bytes** sent to the client as the MCP tool
`content[0].text` after masking and the row cap.

```json
"disclosure": {
  "hash": "sha256:…",
  "bytes": 4821,
  "source": "measured"
}
```

Reproduce the hash:

1. Take the string that was returned (for `query`: `JSON.stringify({ rowCount, fields, rows: rows.slice(0, cap), truncated }, null, 2)`).
2. Encode that string as UTF-8. Do **not** re-canonicalise with JCS — the wire bytes are the fact.
3. `hash = "sha256:" + hex(SHA-256(bytes))`.
4. `bytes` is the UTF-8 length.

Same payload → same hash in any process. The raw payload is **not** stored on
the receipt or in the audit JSONL.

On deny or error, or when no payload was serialised:

```json
"disclosure": { "hash": null, "bytes": null, "source": "undeclared" }
```

Which tools write `measured`, and which do not:

| Tool | `disclosure.source` | Why |
|---|---|---|
| `query` | `measured` | The receipt binds the masked, row-capped JSON that left as `content[0].text`. |
| `search` | `measured` | Same: the serialised search result that left. |
| `describe_table` | `measured` | Same: the serialised table description that left. |
| `list_tables` | always `undeclared` | The receipt is cut **per connector**. The response the client sees is the **combined** JSON of every connector that was listed. Hashing that union into one connector's receipt would commit that receipt to bytes it does not cover. |

`undeclared` here is not a fault. A second implementation that sees it on `list_tables` should not treat the receipt as broken.

Nothing is invented. A low-entropy payload (yes/no, a single row) makes the
hash a **verification oracle** — anyone with the receipt can test a guess.
That is a property of the hash, not a bug. It is written in LIMITATIONS. A
nonce does not fix it: the nonce would sit on the receipt next to the hash.

### Destination (v0.4)

```json
"destination": { "value": "openai/gpt-x", "source": "operator-declared" }
```

The value comes from operator config (`audit.receiptDestination`). Conarium
does not verify it. MCP does not carry model identity. Absent:

```json
"destination": { "value": null, "source": "undeclared" }
```

Policy decisions are **not** bound to `destination` in this version.
Binding access to an unverifiable field would present a declaration as
enforcement. Destination-aware policy is a later job; it needs a verification
path first.

Why this exists: **model identity does not exist in the MCP protocol.** A connecting
client never tells the server which model it is using. Writing a fixed value into config
and signing it would mean Conarium attesting to something it never observed — precisely
the claim this whole artifact is supposed to make impossible. Rather than invent a value
or refuse to emit receipts at all, the receipt records the gap.

`undeclared` is a **valid receipt**, not a broken or incomplete one. The verifier counts
them and reports them (`3 receipt(s) verified (2 with undeclared model)`), so a reader is
never left thinking the signature covers a fact it does not. `source` is inside the hash,
so promoting `undeclared` to `operator-declared` after the fact breaks the chain.

This mirrors `actor.assurance`, which answers *how* an identity is known rather than
merely *who* it is, and the coverage declaration's rule that absence is reported as
*"access NOT RECORDED"*, never *"no access occurred"*.

## Verifier

```
conarium-verify <file|dir> --pubkey <path> [--pubkey <path2>] [--anchor-check] [--require-head-anchor] [--expect-seq-from N] [--expect-count N] [--expect-last-hash sha256:…] [--strict] [--json]
```

`--expect-count` / `--expect-last-hash` are **opt-in tail pins**. Without them,
a chain that had its last receipts deleted still exits 0 — the remainder is a
valid shorter chain. An unpinned run prints one stderr note and, with `--json`,
`"tailPinned": false`. With a pin, a count or last-hash miss is exit **11** (same
code as a `prevHash` break: the chain as presented is not the chain you pinned).
`--strict` requires a tail pin (else exit 11) and, if `--expect-seq-from` is
omitted, pins the first receipt at seq 1. Default exit codes without `--strict`
are unchanged.

| Exit | Meaning |
|---|---|
| 0 | Chain intact, signatures valid |
| 10 | Hash mismatch — record altered |
| 11 | `prevHash` break — deleted or inserted; also `--expect-count` / `--expect-last-hash` mismatch |
| 12 | `seq` gap / non-increasing — missing or reordered |
| 13 | Signature invalid / pubkey missing (fail-closed) |
| 14 | Claimed anchor invalid under `--anchor-check`, or `--require-head-anchor` when the head is unanchored. `anchor:null` receipts are skipped (periodic anchoring). |
| 15 | Anchor **could not be checked** — calendar unreachable, or the OpenTimestamps verifier is not installed. Deliberately distinct from 14: "I could not verify this" is not "this is invalid". The digest comparison is performed offline and still holds; only the timestamp attestation is unconfirmed. A verifier that collapsed the two would be asserting something it did not measure. |
| 20 | Schema invalid |

Fail-closed: if the verifier is unsure, it does not exit 0.

⚠️ Under `--anchor-check`, an OpenTimestamps **calendar** that cannot be
reached is exit **15** (`anchor could not be checked`) — not 14. Digest
comparison is offline and still holds. A `verify()` error that is *not*
classified as unreachable still falls through to 14. There is no separate
block-explorer client in this repository; `ignoreBitcoinNode: true` is set.
Tracked remainder: unclassified network-shaped errors still share 14 with
"proof does not hold".

## Conformance vectors

A specification that cannot be implemented from the document alone is a blog
post. [`test-vectors/`](../test-vectors/) is the difference: twelve frozen cases,
the public key, and a machine-readable manifest.

```
npm run test:vectors
```

Feed each case's `receipts.jsonl` to your verifier with the arguments in
`manifest.json` and compare the exit code. No network, no server, no account.

Two of the cases exist because they are easy to get wrong:

- **005** — the chain still links across a deleted receipt; only `seq` reveals
  the gap. A verifier that checks hashes but not sequence passes it and is wrong.
- **008** — an unsigned receipt with no `--pubkey` still fails. There is no mode
  in which the verifier reports success on a signature it did not check.

The private key is deliberately absent. `expected-hashes.json` publishes the
canonical hashes instead: JCS (RFC 8785) → SHA-256. Match those and your
canonical bytes match ours, which is all interoperability requires — sign with
your own key.

## Coverage declaration (one-sided)

```
conarium-coverage <declaration.json> --pubkey <path> [--receipts <receipts.jsonl>] [--expect-seq-from N] [--allow-gaps] [--json]
```

A signed declaration over a period and the declared scope (`policy.allowTables`):
is the receipt chain contiguous, which declared objects have recorded access and
which do not. The declaration says **"access NOT RECORDED", never "no access
occurred"** — an absent record is ambiguous by nature.

| Exit | Meaning |
|---|---|
| 0 | Declaration signature valid (+ consistent with receipts if given), chain contiguous. Unpinned window start is printed, not a silent complete. |
| 12 | Chain has gaps — coverage incomplete (`--allow-gaps` verifies authenticity only); also `--expect-seq-from` miss |
| 13 | Signature invalid / pubkey missing (fail-closed); also a receipt Ed25519 failure under `--receipts` |
| 20 | Schema invalid |
| 30 | Inconsistent with the receipts file |

## Reconciliation (two-sided, v0.1)

```
conarium-reconcile --before <snapshot.json> --after <snapshot.json> --receipts <receipts.jsonl> [--skew <duration>] [--profile <path>] [--json] [--json-v2] [--result-v2 <path>]
```

The coverage declaration is one-sided: it reports what the receipt chain says
about itself. Reconciliation adds the other side — **the database's own query
counters** — and answers the question receipts alone cannot:

> *The database recorded query activity in this window. Is every bit of it
> receipted — or did something reach the data without passing through the
> gateway?*

Snapshots are taken from the data source's counters (reference implementation:
PostgreSQL `pg_stat_statements`, per role — see `scripts/pg-snapshot.sql`),
once at window start and once at window end, as
`conarium-dbsnapshot/0.1` documents:

```json
{ "v": "conarium-dbsnapshot/0.1", "ts": "…", "role": "conarium_c2",
  "source": "pg_stat_statements",
  "entries": [ { "queryid": "…", "query": "…", "calls": 76 } ] }
```

A query pattern whose calls increased during the window, touching a user table
no in-window receipt covers, is reported as **UNRECONCILED**: access was
**recorded by the database but not receipted**. The gateway may have been
bypassed, or the receipt sink failed — the tool states that fact and does not
claim intent.

Rules that keep the verdict honest:

- **Per pattern and per table, never per call count.** One REST request can
  produce more than one SQL statement (PostgREST does), so call counts and
  receipt counts are not compared 1:1.
- **A clean run means object attribution, not coverage.** Exit 0 says every
  counted pattern names a table for which a receipt exists in the same window.
  One receipt naming a table clears any number of further statements against
  that table inside that window, so the result establishes pattern and object
  overlap — not that each recorded statement was itself receipted. The limit is
  stated in `LIMITATIONS.md` and printed by the tool on a clean run.
- **Nothing is silently cleared.** A pattern whose target table cannot be
  determined is reported UNATTRIBUTED and fails the run. Session/catalog
  housekeeping (`SET`, `pg_catalog`, `information_schema`) is listed as
  infrastructure, visibly.
- **Unreliable windows are refused.** If a counter went backwards or a pattern
  disappeared (stats reset / eviction mid-window), the run fails with exit 20
  instead of producing a verdict from bad data.
- **Receipts with no attributable object make findings non-definitive** and the
  tool says so — same rule as the coverage declaration.
- **A receipt that names an object the counters did not increment is
  UNOBSERVED**, listed separately from `unassigned` (no object named) and from
  UNRECONCILED (database recorded access, no covering receipt). It is
  reported. It does not change the exit code: a window-edge reset, a pooler,
  or a delayed count can produce the same shape, and treating every such
  receipt as a failure has not been shown to be the right rule.
- **A dedicated DB role is a prerequisite.** Reconciling a shared role's
  counters would blame the gateway for other clients' queries.
- **Signatures are not re-checked here.** Run `conarium-verify` first;
  reconciliation assumes an already-verified receipts file. And the counters
  belong to the database: reconciliation trusts the DB's own bookkeeping, so an
  attacker who can silently falsify `pg_stat_statements` is out of scope.

| Exit | Meaning |
|---|---|
| 0 | Every DB query pattern in the window is attributable to receipt(s) for the same table — object attribution, not per-statement coverage |
| 20 | Input invalid or window unreliable (schema error, counter regression) |
| 40 | Unreconciled DB activity — recorded by the database, not receipted |
| 41 | Indeterminate — a pattern is uncovered only by the window boundary, and two clocks decide that boundary |

`--json` is the `/1` body (`conarium-reconcile/0.1`) and the exit codes
above are its contract. `--json-v2` prints a separate
`coverage-reconciliation/2` object; `--result-v2 <path>` writes that object
to a file. The two must not share a body: a consumer MUST NOT read a `/1`
result as a `/2` result. `/2` does not change these exit codes. Signing and
SCITT registration of the `/2` object are out of scope for this version.

Without a Mapping Profile (`--profile`), `/2` sets `profile` to `null`.
Every item whose outcome depends on a multiplicity bound is then
`indeterminate`, an unattributed pattern is `indeterminate` rather than
`observed-without-receipt`, hard-coded infrastructure exclusions are
declared `undeclared` in `bounds`, and `receipted-without-observation`
makes `outcome` `exceptions`.

### The window straddles two clocks

The window is `[before.ts, after.ts]` and both timestamps come from the database.
A receipt's `ts` comes from the gateway. Admitting receipts on an exact comparison
across those two clocks makes the failure **asymmetric**: a gateway trailing the
database turns a receipt that genuinely covers a table into an out-of-window
receipt, and the table into an accusation of bypass. Skew then manufactures the
accusation rather than any real gap, and the sub-second version is the dangerous
one, because it is believed.

A pattern whose uncovered tables **all** have a receipt outside the window is
reported as `indeterminate` and exits 41. It is not a pass — 41 is a failure —
but it is not the bypass sentence either, because this tool cannot tell a trailing
clock from a late receipt.

**Distance is reported, and only the boundary reading is bounded.** Without
`--skew`, *any* covering receipt outside the window puts its pattern at 41 — the
tool still cannot say which access that receipt belongs to. What the distance
decides is whether the boundary can be *offered as the explanation*:

| Offset vs the window's own length | Class | What the report says |
|---|---|---|
| within | `indeterminate`, boundary-plausible | two clocks, cannot tell them apart, **not** reported as unreceipted access |
| beyond | `indeterminate`, **not** boundary-plausible | a boundary artefact cannot explain an offset larger than the window itself; **not excused as a timing effect** |

The threshold is the window's own length (`after.ts − before.ts`), derived from
the input rather than chosen. It exists because the exculpation was attacked and
went through: a legitimate receipt from the previous day, naming the same table,
turned a real in-window bypass from 40 into 41 and the run then said the access
was *"NOT reported as unreceipted access"* — a sentence twenty-three hours of
offset cannot support. 41 was never a silent pass, and is not one now; what
changed is that the tool stops offering an excuse it cannot back.

A declared `--skew` is the operator's own statement about their clocks and
outranks the window rule. A window shorter than a clock correction is possible —
a five-second window and a six-second step would read as beyond the boundary
while being exactly the case the class exists for — and the operator is the one
who knows whether that is their deployment. We have not measured how often it
happens; the flag exists so the answer does not have to come from us:

```
INDETERMINATE: 1 pattern(s) are uncovered only by the window boundary — no --skew bound was declared…
  ~ (+5) table(s) [public.customers] have a receipt 3000ms outside the window: SELECT …
```

`--skew <duration>` declares the bound (`500ms`, `5s`, `2m`, `1h`). A receipt
further out than the bound is not skew, and its pattern goes back to unreconciled
at 40 with the bypass sentence. An unreadable duration is an error, not a default:
a tolerance nobody chose is the kind of number this tool exists to refuse.

A pattern with even one table that has no receipt anywhere is a real gap and stays
at 40 in either mode: a genuine finding is not made indeterminate by a neighbour's
clock.

Credit: raised by Walter Hawkins on the IETF SCITT list, 2026-08-17, against
`bin/conarium-reconcile.mjs` on main.

## Stamping a document (priority dates)

```
conarium-stamp <file> [--sidecar <path>] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | Stamped; sidecar written (`pending` until upgraded) |
| 50 | Stamping failed — calendars unreachable or timed out |

Receipts are not anchored by the write path. An operator stamps a document
with `conarium-stamp`, or submits a chain-head hash through
`conarium-anchor-service`. A git commit date is **not evidence** —
`git commit --date` accepts whatever you type. This stamps the
SHA-256 of a file to the OpenTimestamps calendars and writes the same sidecar shape
those tools use, so `conarium-anchor-upgrade` upgrades it to a Bitcoin block
height unchanged. Only the 32-byte digest leaves the machine.

**What a stamp proves, exactly:** this file existed, byte for byte in this form, no
later than the anchored time. It does **not** prove the file is correct, and it does
**not** prove nobody published something similar earlier. What it does is make our
own publication date checkable by someone who does not trust us — and put any
competing priority claim on the same footing: if an earlier one exists, it can be
demonstrated the same way, with the same kind of evidence.

This specification and [`PRIOR-ART.md`](PRIOR-ART.md) are stamped. Their sidecars sit
beside them (`*.anchors.jsonl`) and re-verify with
`conarium-verify --anchor-check --anchors <sidecar>` or against any OpenTimestamps
client. Because the digest covers the exact bytes, editing either document
invalidates its stamp — a new one is taken and the old sidecar entry stays, so the
revision history is itself timestamped.

## Known gaps (documented, not hidden)

1. **`actor` is a service identity unless per-user tokens are configured.** With a token file (`CONARIUM_TOKENS_FILE`, default `conarium.tokens.json`), the audit line and the receipt name the individual, set `assurance: "per-user-token"` and `type: "user"`. Without it the actor is the connecting service, with `assurance: "shared-token"` and `type: "service"`. `type` is derived from `assurance` rather than carried separately — `resolveActor` is the single place either is decided, so a second field would be the same fact asserted twice. This is an operator-managed token map — **not** OAuth or SSO; there is no identity-provider integration, so the assurance is only as good as the operator's token hygiene. For shared-token deployments, marketing must not claim "who accessed". *Until 0.2.29, `type` was hard-coded to `"service"` regardless: a person connecting with their own token produced a signed receipt naming them and calling them a service. The verifier already rejected `"user"` with `"shared-token"`, but the producing side never emitted `"user"`, so that rule had never fired.*
2. **`dataRefs[].fieldsRequested` and `policy.rulesApplied` are emitted empty.** Until 0.2.29 the first was filled from the masked-field list and the second from the set of SQL functions the query touched — in both cases a field whose name described something other than its contents. A reader takes `fieldsRequested` for the columns a query asked for, and `rulesApplied` for policy rule identifiers; neither was true, and both were signed. They are now empty, because in a signed document a field filled with the wrong thing is worse than a field left empty: empty says *unknown*, wrongly-filled says *known* and misleads. The correct contents are recoverable — selected columns from the SQL AST, rule identifiers from a policy engine that emits them — and neither is implemented; when it is, these fields carry it. **The conformance vectors under `test-vectors/` show both fields populated. Those vectors are hand-written to exercise the format and are not produced by this implementation; a populated value is valid, and an empty one is what this version emits.** Losing per-field masking detail from `dataRefs` is a regression and is stated here rather than absorbed silently — `masking.byClass` still carries the per-class counts.
3. **Bypass detection — addressed as of reconcile v0.1, with stated limits.** Disabling Conarium and reading the DB directly still produces no receipt — no gateway can prevent that from inside. What changed: absence is now *checkable from both sides*. One-sided: `conarium-coverage` emits a signed declaration (chain contiguity + which declared objects have recorded access). Two-sided: `conarium-reconcile` compares the database's own per-role query counters against the in-window receipts and reports any DB-recorded pattern no receipt covers (see §Reconciliation). Remaining limits, stated: reconciliation trusts the DB's own counters (an attacker who can falsify `pg_stat_statements` is out of scope), requires a dedicated DB role per gateway instance, and matches per pattern/table — never per call count. **The language rule stands: "access NOT RECORDED", never "no access occurred."**
4. **Creation-time truth is not proven.** Without hardware attestation, an operator can still write false-but-well-formed receipts *before* anchoring.
5. **In-file `sig` stripping + HMAC/`anchor` reduction.** Content `hash` is computed with `{hash, sig, anchor}` (and audit `signature`/`sig`) excluded, so an operator who controls the file can drop or thin those fields without invalidating the content hash itself. Contiguity and the trust store catch some boot-time cases, but full protection against in-file strip/reduce games is **not solvable in-file** (*in-file çözülemez*) — it needs an external transparency-log anchor and/or out-of-band key ceremony. **Opt-in strict boot (G3):** `CONARIUM_AUDIT_REQUIRE_SIG=1` rejects a chain with any unsigned line when a signing key is configured; the default stays the 08-05 compatibility open. **Mitigation available today, measured:** keep `CONARIUM_AUDIT_HMAC_KEY` enabled alongside Ed25519. HMAC is keyed, so an actor who strips `sig` and recomputes the unkeyed hashes still fails the HMAC check (`entry signature mismatch`). Verified by test: Ed25519 alone → strip-all passes the boot check; Ed25519 + HMAC → caught. `conarium-verify --pubkey` also catches it (exit 13, `missing sig`) because it is told to expect signatures. **Anchor client is available** (`conarium-stamp` / `conarium-anchor-service`; `CONARIUM_ANCHOR_SINK=opentimestamps` selects the calendars). Receipts start as `anchor: null`. After a stamp is submitted the sidecar is `pending` until Bitcoin finality (hours); see §Anchoring.
6. **`argsHash` hurts debugging.** Support cases need the customer's own logs to correlate.
7. **Tail truncation is invisible to `conarium-verify` unless pinned.** Deleting the last N receipts leaves a consistent leftover chain (exit 0). `--expect-count` / `--expect-last-hash` exist for operators who have an external length or last-hash; they are opt-in so a verifier that saw the same file yesterday still exits 0 today. Anchoring the head, or `conarium-reconcile` against the database's own counters, are the other pins.

## Anchoring (OpenTimestamps)

Receipts are not stamped by the write path. `Audit.writeReceipt` emits
`anchor: null`. An operator stamps a file with `conarium-stamp`, or submits
a chain-head hash through `conarium-anchor-service`. Those tools talk to the
**OpenTimestamps** calendars. `CONARIUM_ANCHOR_SINK=opentimestamps` selects
the in-tree calendar client they use; it does not stamp receipts as they
are written. Only the raw 32-byte digest is sent (our `sha256:<hex>` prefix
is stripped first). Proofs live in a sidecar `<sink>.anchors.jsonl`; after
a stamp is submitted, the receipt’s `anchor` field is a hash-exterior
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
is disclosed — `conarium-verify --anchor-check` skips `anchor:null` (nothing
has been submitted yet), exits 0 with a stderr warning while pending, and exits 14 if a
*claimed* anchor's proof is missing or does not match the hash. The run prints
`N/M anchored, head anchored: yes/no`. `--require-head-anchor` exits 14 when
the chain head is unanchored.

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
