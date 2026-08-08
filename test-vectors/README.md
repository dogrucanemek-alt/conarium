# Conarium Receipt — conformance vectors

Frozen inputs and expected results for anyone implementing or checking a
Conarium Receipt verifier. Nine cases, one public key, one manifest.

A specification that cannot be implemented from the document alone is a blog
post. These vectors are the difference.

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

`scripts/gen-test-vectors.mjs` produced these files. Do not run it to make a
failing test pass. If a change to this repository breaks a vector, the format
changed, and that is the signal the vectors exist to raise. Change the code, or
change the specification and the version string with it.

The frozen hash of case 001 is asserted separately in `test/vectors_run.mjs`
for exactly this reason.
