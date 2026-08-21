# Conarium Receipt — conformance vectors

Frozen inputs and expected results for anyone implementing or checking a
Conarium Receipt verifier. Thirteen cases, one public key, one manifest.

A specification that cannot be implemented from the document alone is a blog
post. These vectors are the difference.

## Before you write a verifier

Read [Wire format for a second implementation](../docs/RECEIPT-SPEC.md#wire-format-for-a-second-implementation)
first. It carries the things these vectors do not tell you on their own: what
the Ed25519 signature actually covers, that `seq` advances by exactly one,
which absent fields are schema errors rather than tampering, and the order the
checks run in.

That section exists because someone built a verifier from this directory and
reached 13/13 only after opening our source. It is not repeated here — a fact
written down twice by hand is a fact that will disagree with itself. The parts
of it marked *measured* — the signed payload, the sequence rule, the
required-field table and the check order — are asserted against the shipped
verifier by `test/spec_wire_contract.mjs`. The rest is prose, and says so.

## Run them

Against this repository's verifier:

```
npm run build && npm run test:vectors
```

Against your own implementation: read `manifest.json`, feed each case's
`receipts.jsonl` to your verifier with the listed arguments, and compare the
exit code. Nothing else is required — no network, no server, no account.

```json
{
  "name": "003-tampered-field",
  "args": ["--pubkey", "KEYS/vector-key.pub.pem"],
  "exitCode": 10
}
```

`KEYS/` resolves to `test-vectors/keys/`.

## The cases

| Case | What it is | Exit |
|---|---|---|
| 001-single-receipt | One valid signed receipt | 0 |
| 002-chain-of-three | Three receipts linked by `prevHash` | 0 |
| 003-tampered-field | `outcome.rows` edited after signing | 10 |
| 004-prevhash-break | Middle receipt deleted | 11 |
| 005-seq-gap | `seq` jumps 1 → 7 while `prevHash` still links | 12 |
| 006-bad-signature | One byte of the signature flipped | 13 |
| 007-schema-invalid | `policy` removed — not a receipt at all | 20 |
| 008-unsigned-no-pubkey | Unsigned receipt, no `--pubkey` given | 13 |
| 009-unsigned-but-pubkey-given | Unsigned receipt, signature demanded | 13 |
| 010-disclosure-commitment | 0.4 receipt, `disclosure` measured over the payload that left | 0 |
| 011-destination-declared | 0.4 receipt, destination `operator-declared` | 0 |
| 012-mixed-chain | One 0.3 receipt then one 0.4 receipt; the chain verifies | 0 |
| 013-disclosure-keys-omitted | 0.4 receipt, `disclosure` is `undeclared` but `hash`/`bytes` are omitted, not `null` | 20 |

Exit codes are the ones in [RECEIPT-SPEC.md](../docs/RECEIPT-SPEC.md); the
drift guard in `test/spec_exitcode_drift.mjs` keeps the two in sync.

## Two properties worth pointing at

**005 exists because `prevHash` alone is not enough.** The chain still links
correctly across the gap — only the sequence counter reveals that something is
missing. A verifier that checks hashes but not `seq` passes this case and is
wrong.

**008 and 009 both return 13, and that is the point.** There is no mode in
which the verifier reports success on a signature it did not check — not even
when the caller never asked for one. Silence is not a pass. This vector was
originally written expecting `0`; the verifier disagreed and the verifier was
right, so the expectation was corrected rather than the behaviour.

## JCS vectors — [`jcs/`](jcs/)

The thirteen cases above are ASCII-keyed with integer and string values, so a
naive sorted-key serialiser reproduces all thirteen hashes. That is still true
and is not a defect in them: a receipt body *cannot* carry a float or a
non-ASCII key. Its only numbers are `chain.seq`, `masking.pii` and
`outcome.rows`.

Canonicalisation is reachable from outside at one point — `hashArgs()`, the
tool arguments an operator's client sent, typed `any`, digested into
`request.argsHash`. [`jcs/args/`](jcs/args/) publishes eight preimages for it
with their frozen hashes: floats at the `1e21` exponent boundary and the
denormal minimum, integers past 2^53, non-ASCII keys, a surrogate-pair sort
order, escape rules, and the raw-string branch.

Read [`jcs/args/expected-args-hashes.json`](jcs/args/expected-args-hashes.json)
before implementing against them — `kind` decides whether the file is parsed
and canonicalised or digested as the bytes it is. Getting that wrong is the
single most likely way two implementations disagree here.

Our own conformance against the RFC's reference data — six input/expected pairs
byte for byte, and 3,000 published IEEE-754 doubles — is measured by
`test/spec_jcs_class.mjs`, alongside eight mutants it must catch. The number
evidence is a **sample** of the reference's 100,000,000 and says so; see
[`jcs/rfc8785/PROVENANCE.md`](jcs/rfc8785/PROVENANCE.md), which also records
that the vendored fixtures are Apache-2.0 and not ours.

## The key, and why the private half is not here

`keys/vector-key.pub.pem` is published. The private half is not, and will not
be. A private key committed to a public repository is a private key that has
leaked, no matter how loudly the filename shouts otherwise — this project has
already had one near miss with exactly that, and the rule that came out of it
holds here too.

The cost is that you cannot byte-compare your *signatures* against ours. That
matters less than it sounds: signing is RFC 8032, implemented correctly by
every mainstream crypto library, and none of it is ours.

What is ours — and what silently breaks between implementations — is the
canonical form. So `expected-hashes.json` publishes that instead:

```
canonicalise(receipt minus chain.hash, sig, anchor) with JCS (RFC 8785)
  -> SHA-256  ->  compare
```

If your hash matches ours, your canonical bytes match ours, which is the only
thing an interoperable receipt actually requires. Sign it with your own key.

## Regenerating — read before you do

`scripts/gen-test-vectors.mjs` produced 001–009. It now refuses to run if those
files exist. `scripts/gen-test-vectors-04.mjs` appended 010–012, then 013. Do
not run either to make a failing test pass. If a change to this repository
breaks a vector, the format changed, and that is the signal the vectors exist
to raise.

The frozen hash of case 001 is asserted separately in `test/vectors_run.mjs`
for exactly this reason.

SQL-gate attack leftovers (not receipts) live in [`sql-gate/`](sql-gate/).
They are produced only when `test/property_sql_gate.mjs` finds a bypass.
