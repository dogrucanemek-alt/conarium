# Countersign

What a VERAX countersign is, and what it is not. Measured. No dates.

The service code is MIT and public. The secret is the Ed25519 key, not
the code. A customer can read every line of what we do with their hash.
What is sold is that we run that code under our name and keep the log.

## What it proves

Given a countersign record, our published public key, and (optionally)
an inclusion proof:

1. **We saw this hash.** The record's `digest` is bound by our signature.
2. **We wrote it at this place in our log.** `seq` / `prevHash` / `hash`
   are in the signed body. A later hand-edit fails the chain check
   (`validateAnchorLog`) and the service refuses to serve the file.
3. **The log was not rewritten in place.** A `pending → bitcoin` change
   is a new `type: 'upgrade'` row. The original line stays.
4. **A third party can check without our help.**
   `conarium-countersign-verify` imports nothing from `src/`.
   `GET /anchor/:id` carries an inclusion path to the current head.
   `GET /anchor/key.pem` is the public half of the current key.

The OpenTimestamps stamp on the **log head** (not on every submit) is a
calendar promise until a Bitcoin block confirms it. Conarium is not the
time source. The calendars and Bitcoin are.

## What it does not prove

- That the customer's own records are true.
- That VERAX is honest. A key holder can countersign anything. The
  signature proves *who signed*, not *that the signer told the truth*.
- That a hash existed at a wall-clock time. Until the head stamp
  confirms on Bitcoin, time is a calendar promise. See
  [LIMITATIONS.md](../LIMITATIONS.md) — "Anchors may stay pending".
- That the operator's process was not skipped. The same limitation as
  the gateway: code that holds the key can sign without going through
  this HTTP service.

This is the same class of claim as a notary stamp on a photocopy: it
says we held this digest, in this order, under this key. It does not
say the photocopy is of a true original.

## Key custody

| | |
|---|---|
| Private key | `CONARIUM_ANCHOR_SIGNING_KEY` — a file path. The process **refuses to start** without it (exit 2). |
| Key id | `CONARIUM_ANCHOR_KEY_ID`, or the `<pem>.keyid` sidecar. |
| Public key | Derived and served at `GET /anchor/key.pem`. A body that looks like a private PEM is refused with 403. |

The private key does not leave the host that runs
`bin/conarium-anchor-service.mjs`. It is not in the store, not in the
public view, not in the npm package.

**If the private key leaks, every countersign under that keyId is
worthless.** An attacker can mint records that verify. There is no
recall. Rotate (below). Treat the leak as a compromise of the product,
not an operational inconvenience.

There is no HSM integration in this tree. Custody is "the file on that
box, mode 0600 on POSIX". That is a limitation, not a plan.

## Rotation

Old records keep their `sig.keyId`. Verification loads the public key
that matches that id (`--pubkey` + `.keyid` sidecar), not "whatever is
current".

To rotate:

1. Generate a new Ed25519 pair (`keyId` must be new).
2. Keep the old public PEM + `.keyid` where verifiers can find them.
3. Point `CONARIUM_ANCHOR_SIGNING_KEY` at the new private key.
4. Restart. New rows sign with the new id. Old rows still verify with
   the old public key.

Do not delete an old public key while any record that names it must
still be checked.

## Outage

Submit does not talk to a calendar. A calendar outage is not a 5xx on
`POST /anchor`. The record is accepted and countersigned; the head
stamp runs on the next maintenance tick (`CONARIUM_ANCHOR_UPGRADE_MINUTES`).

A missed tick is retried. Inclusion through the next stamped head is
how a record becomes timestamped. Until that stamp exists,
`GET /anchor/:id/ots` is 404 — "not yet stamped" — not a fake proof.

If the process itself is down, nothing is countersigned. That gap is
visible as a seq hole only if a later operator forges one; a honest
restart continues from the last line on disk.

## How to check

Save the `countersign` object from `POST /anchor` (the signed row, not
the public projection). Then:

```
curl -fsS https://<origin>/anchor/key.pem -o key.pem
curl -fsS https://<origin>/anchor/key.pem.keyid -o key.pem.keyid
node bin/conarium-countersign-verify.mjs record.json --pubkey key.pem
```

Optional inclusion (file, or a live read):

```
node bin/conarium-countersign-verify.mjs record.json --pubkey key.pem --inclusion proof.json
node bin/conarium-countersign-verify.mjs record.json --pubkey key.pem --log-url https://<origin>/anchor/<id>
```

Exit codes (same class as `conarium-verify`):

| | |
|---|---|
| 0 | signature valid; inclusion valid if one was given |
| 13 | signature invalid / no pubkey / unknown keyId |
| 14 | inclusion proof present and false |
| 15 | log could not be checked (unreachable) — not the same as 14 |
| 20 | schema invalid |

## Two hashes, on purpose

The countersign signature is over RFC 8785 JCS of the record with `sig`
removed (`src/receipt.ts` `canonicalize`). The log chain hash is
`computeEntryHash` from `src/audit-hash.ts` (`JSON.stringify` of
insertion order, `hash`/`sig`/`anchor` excluded). They are the two
hashers this repository already has. A third one was not added.
Independent re-hash of a chain row must use `JSON.stringify`, not JCS.
See LIMITATIONS.md — "Audit sink hash is not JCS".

The customer digest lives in `digest`. The field `hash` on a stored
row is the entry hash, the same name audit uses; it stays that way
because the signature covers the field names, so renaming it would
change the signed bytes of every record.

Public JSON does not reuse either name loosely: the submitted value is
`digest` and the row's own link is `chainHash`. It used to expose the
customer digest as `hash` while the inclusion proof beside it used the
same word for the entry hash — one word, two values, in a document
whose only job is to be unambiguous to a reader who does not trust us.
