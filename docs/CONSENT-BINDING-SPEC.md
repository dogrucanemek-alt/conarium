# Consent Binding Spec v0.1 (draft — specification only, not implemented)

Binding a data-access receipt to the **consent record that authorised it**, so a third
party can check — offline, without trusting the operator — whether an access had a
consent basis behind it at the moment it happened.

**Status: design published, not implemented.** `Receipt.consentRef` has been reserved
and `null` since receipt v0.1 for exactly this. Nothing in this document ships yet.
It is published now so the design is on the record with a verifiable date; see
[RECEIPT-SPEC §Stamping](RECEIPT-SPEC.md).

## The gap this addresses

Two mature standards exist and nothing joins them.

[ISO/IEC TS 27560:2023](https://arxiv.org/abs/2405.04528) defines the consent record
and the consent receipt — an authoritative, machine-readable statement that consent
exists, what it covers, and what happened to it. Access logs and access receipts (this
project, and everyone in [`PRIOR-ART.md`](PRIOR-ART.md)) record that data was touched.

Nobody joins them cryptographically. So today an operator can hold a perfect consent
archive and a perfect access log and still be unable to answer the only question a
regulator actually asks:

> *Was there a valid consent basis behind **this specific access**, at the time it
> happened?*

Answering it by matching timestamps in two databases is exactly the self-attestation
this project exists to replace: both databases belong to the operator, and both are
editable.

## Design

### `consentRef` in the access receipt

`Receipt.consentRef` changes from `null` to either `null` (unchanged meaning: no
consent evidence attached) or:

```json
{
  "basis": "consent",
  "recordHash": "sha256:…",
  "recordId": "opaque-operator-id",
  "issuer": "did:example:controller | https://…",
  "state": "active",
  "stateAsOf": "2026-08-06T19:15:25.452Z",
  "source": "verified" | "operator-declared" | "unavailable"
}
```

- **`recordHash`** — SHA-256 over the canonical (JCS) form of the ISO 27560 consent
  record as it stood **at the moment of access**. This is the binding. Because it
  sits inside the access receipt's own hash, and the receipt is Ed25519-signed and
  chained, the operator cannot later swap in a different consent record.
- **`state` / `stateAsOf`** — `active`, `withdrawn`, or `expired`, and when that was
  evaluated. This is what makes the binding worth having: an access carrying
  `state: "withdrawn"` is self-incriminating evidence the operator signed themselves.
- **`source`** — the same provenance discipline as `model.source` and
  `actor.assurance`. `verified` means Conarium fetched and hashed the record itself;
  `operator-declared` means it was asserted by configuration and **not** checked;
  `unavailable` means the consent store could not be reached and the fields are null.
  A receipt never claims a consent basis Conarium did not observe.
- **`basis`** — consent is one of six GDPR lawful bases. A receipt may legitimately
  carry `basis: "contract"` or `"legal-obligation"` with no `recordHash`. The point is
  that the basis is *stated and signed*, not that it is always consent.

### Verification, offline

A third party given (a) the access receipts, (b) the operator's public key, and
(c) the consent receipts:

1. Verify the receipt chain — `conarium-verify`, unchanged.
2. For each access receipt with a `consentRef`, canonicalize the matching consent
   receipt and recompute its hash. Mismatch ⇒ the consent record shown is not the one
   that was in force at access time.
3. Report accesses whose `consentRef` is `null`, `unavailable`, or whose `state` was
   not `active`.

Step 3 is the output that matters, and it completes the sentence this project has
been building toward:

> *The vendor declared 400 accesses; I hold 380 receipts; 20 are unaccounted for
> ([reconciliation](RECEIPT-SPEC.md#reconciliation-two-sided-v01)); and 12 of the
> accesses I do hold have no valid consent behind them.*

### What it proves, and what it does not

It proves that at access time the operator held a consent record with exactly this
content and this state, and that the claim has not been altered since — because it is
inside a signed, chained receipt.

It does **not** prove the consent was validly obtained. Freely given, specific,
informed, unambiguous — those are legal questions about how the consent was collected,
and no hash can answer them. It also does not prove processing was lawful: a missing
or withdrawn consent may be perfectly fine under a different basis.

**Language rule, carried over:** the output says *"no consent evidence is bound to
this access"*, never *"this access was unlawful."* Same discipline as *"access NOT
RECORDED"* rather than *"no access occurred."* An operator whose consent store was
unreachable produces `unavailable`, and that is a different fact from `withdrawn`.

## Prior art, as far as we have looked

Two searches on 6 August 2026 (`"consent receipt" cryptographically bound to access
log audit trail implementation`, and ISO 27560 + access record + cryptographic proof)
found consent-management platforms that log consent with metadata
([UniConsent](https://www.uniconsent.com/blog/uniconsent-consent-audit-trail),
[consentmanager](https://www.consentmanager.net/en/help/developer-reference/consent-log-protocol-audit-trail/)),
e-signature audit trails that hash the *document* at signing, and the
[DPV/W3C guidance](https://www.w3.org/community/reports/dpvcg/CG-FINAL-guide-27560-20240801/)
for expressing 27560 records. ISO 27560 itself notes cryptographic hashes may protect
the consent record — **from tampering with itself**, not as a binding to an access
event.

The nearest thing found is the AgentBound framework
([arXiv 2606.30970](https://arxiv.org/pdf/2606.30970)), whose governance receipts
*"cryptographically bind each discrete agent action to the exact policy artifacts
responsible for its runtime outcome."* Same architecture, different object: policy,
not consent.

**No implementation binding a consent record to a specific data-access record was
found.** Two searches are not a prior-art clearance. This is a scan, not a legal
opinion, and it is recorded here so it can be checked and corrected.

## Before this is implemented

- **Patent review is a prerequisite, not a formality.** This area is dense —
  `US 11032071`, `US 10678945`, `US 10440062`, `US 10776518` are known to sit nearby,
  and [h33.ai](https://h33.ai/) states ten pending applications, six numbered publicly.
  None has been read against this design.
- The consent store interface must be pluggable. Conarium will not become a consent
  management platform; MyData operators, Consentua and the CMPs already do that well,
  and reimplementing them would be the mistake this project made a point of avoiding.
- `verified` requires reading the consent store on the access path. The latency and
  failure-mode budget for that is not designed yet — and `unavailable` must never
  silently degrade into `operator-declared`.
