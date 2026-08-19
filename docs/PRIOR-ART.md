# Prior art — who else does this?

We make one comparative claim about Conarium:

> Conarium is the only implementation **we are aware of** that combines
> (1) inline enforcement, (2) a portable, offline-verifiable receipt of that
> enforcement, and (3) coverage reconciliation against the data source's own
> query counters.

⚠️ **Read that as a claim about implementations.** Since 19 August this file
carries a project that *specifies* part 3 without our finding it implemented —
see the Vaara row and the note under the table. The idea is not ours alone; the
running code, as far as this scan reaches, still is.

A claim like that is unfalsifiable if we just assert it, so this file is the
evidence behind it: what we searched, on what date, what we found, and — the part
most comparison pages leave out — **what we could not verify.** If you know of an
implementation that does all three, open an issue and this file will be corrected.

**Scan date: 6 August 2026.** Method: fetched each project's README, docs and
official site, plus targeted web searches. **Source-code-level search was not
performed on any repository** — see Limitations.

**Amended 19 August 2026.** Vaara was added after its author raised a related
mechanism on the SCITT mailing list. It is the one row scored from source rather
than from documentation: the repository was cloned at `befdced`, its contiguity
tests were run (`PYTHONPATH=src python -m pytest tests/credential/test_contiguity.py`
→ 18 passed), the cited design sections were read, and the tree was searched for
code implementing them. That search is why the row was rescored the same day —
see the note under the table.

## What the three parts mean

Precision matters here, because two of them are commonly confused:

1. **Enforcement** — policy and masking applied *before* the model sees the value.
   Not "the log records that it happened", but "the value never left".
2. **Portable receipt** — a signed artifact a third party verifies **offline**,
   without trusting the vendor or the operator.
3. **Coverage reconciliation** — comparing the receipt chain against the **data
   source's own bookkeeping** to surface access the source recorded and the chain
   does not.

Part 3 is **not** hash-chain verification. A contiguous, signature-valid chain says
*"what I hold has not been altered."* It cannot say *"nothing is missing from what I
hold"*, because a gateway that was bypassed writes nothing at all and its chain stays
perfectly intact.

## Findings by project

| Project | Enforcement | Portable signed receipt | Coverage reconciliation |
|---|---|---|---|
| [microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit) | Partial — Cedar allow/deny, DLP attribute ratchets; PII masking not documented | **Yes** — Ed25519, hash-chained (`parent_receipt_hash`), `verify_receipt_chain()`. This said "Merkle-chained" until 19 August; their tutorial describes a linear parent hash, and overstating a competitor's mechanism is the same defect as overstating our own | No |
| [Signet](https://github.com/Prismer-AI/signet) | Partial — policy bound into the receipt; no masking | **Yes** — Ed25519, hash-chained, offline | No |
| [Handshake.AI](https://handshake.ai/) | No | **Yes** — signed action receipts, DID-issued, offline | No |
| [hoophq/hoop](https://github.com/hoophq/hoop) | **Yes — strongest here.** ML-based masking before bytes leave the gateway | No — session recording/replay, no signed offline-verifiable artifact found | No |
| [Circe](https://github.com/wv26296-ux/circe-receipts) | No | **Yes** — Ed25519 + JCS, offline | No — explicitly out of scope |
| [VeritasActa/Acta](https://github.com/VeritasActa/Acta) | Partial — Cedar policy; masking not documented | **Yes** — Ed25519, 2 IETF Internet-Drafts, offline CLI | No |
| [agentreceipts.ai](https://agentreceipts.ai) | Different — parameters hashed, not masked | **Yes** — W3C VC + Ed25519, three SDKs cross-verify | No |
| [lasso-security/mcp-gateway](https://github.com/lasso-security/mcp-gateway) | **Yes** — Presidio PII masking, injection filters | No — no signing mechanism documented | No |
| [h33.ai](https://h33.ai/) | **Yes, and further** — FHE; the model never sees plaintext | **Yes** — ZK-STARK + Dilithium, verifiable "years later, offline, without the original vendor" | No |
| [CertNode](https://certnode.io/solutions/ai-agents) | Weak — no blocking gate | **Yes** — ES256 JWS + RFC 3161 | No |
| [vaaraio/vaara](https://github.com/vaaraio/vaara) | Partial — `CredentialGateway` authorizes each tool call against a brokered credential and refuses without one; no value masking found. Its redaction is GDPR Art. 17 erasure inside the audit store, which is a different guarantee | **Yes** — signed decision record (ES256/HS256/RS256) over JCS-canonical blocks, evidence pinned by `evidenceRef.digest`, standalone checkers under `tests/vectors` that import none of their code | **Specified, not found implemented.** `docs/design/credential-broker-spec.md` §D designs the join — each used credential to a receipt on `attestationDigest`, a used credential with no matching receipt read as a bypassed broker — and §E states its limit: *"detection of a defeated broker, not a mathematical-completeness claim"*. At `befdced` we found no collector, join, CLI or test implementing it; `gateway.py` points at the design document for that residual rather than at code. **This is the only design for it we have found outside our own** |

The landscape splits cleanly. One camp enforces well but issues no portable evidence
(hoop.dev, Lasso). The other issues excellent portable evidence but does not enforce
before the model (Signet, Circe, Acta, agentreceipts, Handshake, CertNode). Three
projects do the first two — Microsoft's toolkit, h33.ai and Vaara — and none of
them was found running the third.

### What the Vaara row cost the claim, and what it did not

This row was scored twice on 19 August, and the first scoring was wrong in a way
worth leaving on the page.

It first read **Yes** on coverage reconciliation, on the strength of
`credential-broker-spec.md` §D. That section designs the join and states its own
limit honestly, and reading it is enough to see that someone else has had this
idea and thought it through. It is not enough to see it run. A search of the tree
at `befdced` for a collector of used credentials, a join, a CLI or a test found
none, and `gateway.py` refers that residual to the design document rather than to
code. Scoring a specification as behaviour is the same confusion this file's own
column definitions warn about two sections above — *"not that the log records that
it happened, but that the value never left"* — committed by the person who wrote
them.

So the combined claim stands on implementation, which is what every other row in
this table is scored on. What it can no longer carry is the suggestion that
nobody else has arrived at the idea. Someone has, in public, with the limits
stated. The honest form:

> **We have not found another implementation that masks values before the model
> sees them and then reconciles what it disclosed against the source's own
> bookkeeping. One other project specifies such a reconciliation; we did not find
> it implemented.**

Anyone quoting this file should quote that, not "nobody else reconciles" and not
"none of the ten has the third column".

### Two near misses worth naming precisely

**Microsoft's toolkit has something called "reconciliation", and it is a different
thing.** [Agent discovery](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/tutorials/29-agent-discovery.md)
reconciles *discovered agents against a governance registry* to find shadow agents —
inventory, not data access. Its ["completeness score"](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/tutorials/50-decision-bom.md)
measures how many required fields it managed to populate from signals it already
collected. Neither asks whether the data source saw access the chain has no receipt
for. Their own [Discussion #276](https://github.com/microsoft/agent-governance-toolkit/discussions/276)
is candid about the boundary: *"What we don't do yet is treat the decision as a
sealed, independently verifiable artifact in the way you describe."*

**[MintMCP Agent Monitor](https://www.mintmcp.com/blog/agent-gateway) is the closest
commercial attempt at bypass detection** — it *"tracks agent activity across the
organization, including MCP calls made outside the gateway through hooks in Cursor
and Claude Code."* That is client-side instrumentation: it sees what the client tells
it. It is not the data source's own telemetry, and it comes with no signed receipt.

## The closest prior art is a paper, and it names the gap exactly

[*Notarized Agents / Sello* (arXiv 2606.04193)](https://arxiv.org/html/2606.04193v1)
states the problem better than we did:

> *"An inclusion proof answers 'is this receipt in the log?' It does not answer 'did
> the log return every matching receipt?'"*

We are not claiming to have discovered this gap — that paper published it, and
[*Auditable Agents* (arXiv 2604.05485)](https://arxiv.org/abs/2604.05485) independently
calls evidence integrity and lifecycle coverage the most neglected dimensions of
current audit approaches. What we note is that Sello's three proposed remedies all
stay on the log side: a signed exhaustive answer from the log (SCITT/SCRAPI),
downloading the whole log and scanning locally, or submitting to several independent
logs. Sello v0.1 explicitly declines to guarantee set completeness.

**Reconciling against the data source's own counters is not among the proposals we
found, in that paper or anywhere else in this scan.** That is the specific thing
`conarium-reconcile` does, and the specific reason we think the combination is
currently unusual. Also worth stating plainly: none of the three parts is an
invention. Enforcement, Ed25519 receipts and query counters are all mature. The
combination is the claim — the same way SPDX and CycloneDX did not invent dependency
lists.

## Patent scan, 8 August 2026 — including a correction to this document

The scan above looked at *projects*. This section looks at *patents*, and it corrects
a claim made earlier in this file.

**Method:** claim 1 of each patent was read in full and mapped element-by-element
against the design in [CONSENT-BINDING-SPEC.md](CONSENT-BINDING-SPEC.md). Family and
legal-status data from Google Patents (INPADOC-derived). Claim texts from
freepatentsonline; **not yet checked against the official USPTO PDFs.** This is a
scan, not a freedom-to-operate opinion, and it was not performed by a lawyer.

| Patent | Owner | Family | Nearest-element verdict |
|---|---|---|---|
| `US 11032071 B2` — Secure and verifiable data access logging system | **Microsoft** | US only | 4 of 7 elements absent: no request token is generated or returned to the client, and the data server never calls back for a request digest. Their architecture is three-party and requires changes at the data server; ours is a single in-line gateway against an unmodified PostgreSQL. |
| `US 10678945` · `US 10440062` · `US 10776518` — Consent receipt management systems | **OneTrust** | US only | At least 5 elements absent in each. These claim a *consent collection* platform: a UI shown to the data subject, generation of a consent receipt key, a virtual browser capturing the blank consent form, and transmission of a receipt **to the data subject**. Conarium never interacts with a data subject and does not collect consent — it hashes a consent record someone else holds into an access receipt. |
| `US 11790111` · `US 12105843` · **`EP 3861676 B1`** — Verifiable consent for privacy protection | **Google** | US · EP · CN · WO | **Conceptually the closest found.** An attestation token carrying user consent data and a digital signature. But the direction is inverted: theirs is an *input* credential validated before an action is permitted (including a token-freshness window and, in `11790111`, selecting ad components); ours is an *output* artifact recording what already happened. Elements (a), (d) and (f) are absent. |
| `US 7770032 B2` — Secure logging for irrefutable administration | — | US · EP · WO | **Expired.** Hash-chained, MAC-protected log entries — the technique underneath our own chain. Its expiry is worth stating plainly: tamper-evident logging is old, public art, and we have never claimed otherwise. |

### 🔴 Correction to this document

This file names **h33.ai** as one of two projects doing both enforcement and portable
evidence, and cites its ten stated patent applications. That product-level reading
stands — it came from their own site and nothing here refutes it. What was wrong was
the inference drawn from it: that those applications might cover the consent-binding
ground. The six published application numbers were read on 8 August 2026 and their
subject matter is **not** consent-to-access binding:

| Application | Subject |
|---|---|
| `19/645,499` | Substrate — FHE ↔ post-quantum interface architecture |
| `19/656,024` | NTT — number-theoretic transform optimisation |
| `19/661,294` | Upstream — asset provenance and encrypted metadata |
| `19/669,799` | TFHE routing — homomorphic engine selection |
| `19/683,841` | Q-Sign — authorisation and signing |
| `19/693,384` | Agent-Zero — multi-agent accountability |

`19/645,499` is a post-quantum attestation primitive that commits a computation result
in 58 bytes and anchors it to Bitcoin. That is a different object from binding a
consent record to a data-access record. The earlier framing overstated the overlap.

Four of the stated ten applications remain unpublished and therefore invisible. That
uncertainty is unresolved and cannot be resolved from outside.

### What this scan does not settle

- `EP 3861676 B1` was granted 2025-08-06 and **Turkey is among its designated states**.
  Designation is not validation: enforceability in Turkey requires a national
  validation filing. **The Turkish register was searched on 2026-08-08 and returned
  no record** (TÜRKPATENT patent search, *EPC Yayın Numarası B1* = `EP3861676B1`).
  The search method was verified against a positive control first: `EP3547077B1`, a
  Google EP that **is** validated in Turkey, returns its Turkish record
  (`2024/002851`). A first attempt using the bare number `3547077` returned nothing
  for that known-good patent — the field requires the full `EPxxxxxxxB1` form, so the
  format had to be fixed before the negative meant anything. Consistent with INPADOC:
  of the 27 countries with national post-grant events on this patent Turkey is not
  one, and the proprietor let it lapse in 18 contracting states during 2026.
  This is a register search, not legal advice, and a register can lag.
- Only claim 1 of each patent was analysed. Other independent claims were not.
- Prosecution history, claim construction and the doctrine of equivalents are
  outside what a document scan can reach.
- Maintenance-fee status was not verified at USPTO Patent Center.

## Limitations of this scan — read these before citing it

An unread source is not a cleared source, and an empty search result is not evidence
of absence. Both mistakes have been made on this project before.

1. **No source-code-level search was performed on any repository.** README and docs
   only. An undocumented `reconcile*` implementation could exist, most plausibly in
   Microsoft's toolkit (hundreds of files) or hoop.
2. **[kriyanative.com/blog/13-chain-breaks](https://kriyanative.com/blog/13-chain-breaks/)
   returned HTTP 403 and could not be read.** Its title — *"I hash-chained my agent's
   audit log. Then I found 13 breaks in it"* — touches exactly the integrity-versus-
   coverage distinction. Unevaluated, not dismissed.
3. **h33patent.com could not be fetched** (TLS certificate mismatch). h33.ai publishes
   6 application numbers of a stated 10; the remainder are not public. The six were
   read on 2026-08-08 — see the correction above — but the four unpublished ones
   remain invisible.
4. Only four h33.ai pages were read. Its blog archive, PDFs and whitepapers were not.
5. hoop.dev's full `docs/*` tree was not traversed — README and search snippets only.
6. No formal "non-goals / limitations" section was found for Acta; we could not
   confirm one does not exist. The IETF drafts were not read in full.
7. Issue and discussion trackers were not searched for most projects — reconciliation
   may sit on a roadmap.
8. **Two searches returned topically unrelated results** (accounting "proof of cash",
   payment reconciliation) rather than nothing. That means those terms are not indexed
   the way we assumed — it is not evidence that nothing exists.
9. Searches for `pg_stat_statements` combined with audit reconciliation returned only
   performance tuning and pgAudit material across three separate queries. No
   implementation reconciling those counters against a receipt or audit chain was
   found.

## What we will claim about being early

We will not claim to be first in the world at any of the three parts, and certainly
not at data masking — Presidio, hoop.dev and Lasso all mask, and several of them mask
better than we do.

The claim we will make is narrower and checkable: **this specification and this scan
were published on a date we can prove.** Both files are stamped to OpenTimestamps and
upgradeable to a Bitcoin block height (see [RECEIPT-SPEC §Stamping](RECEIPT-SPEC.md)).
A git commit date proves nothing — `git commit --date` accepts any value — so we do
not rely on one.

That converts an unwinnable argument into an evidentiary one. We are not asserting
that no earlier implementation exists. We are putting our date on the record in a
form nobody has to trust us for, and any competing priority claim can be settled the
same way: show the artifact, show the timestamp.

## Why the claim stays hedged

We will not write "the world's first" or "the only one in existence". Those are
universal negatives, and this project has already had a "first" claim collapse under
checking four separate times. "The only implementation we are aware of, here is the
scan, correct us" is both the honest form and — for the kind of reader who audits
things for a living — the more credible one.
