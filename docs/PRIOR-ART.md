# Prior art — who else does this?

We make one comparative claim about Conarium:

> Conarium is the only implementation **we are aware of** that combines
> (1) inline enforcement, (2) a portable, offline-verifiable receipt of that
> enforcement, and (3) coverage reconciliation against the data source's own
> query counters.

A claim like that is unfalsifiable if we just assert it, so this file is the
evidence behind it: what we searched, on what date, what we found, and — the part
most comparison pages leave out — **what we could not verify.** If you know of an
implementation that does all three, open an issue and this file will be corrected.

**Scan date: 6 August 2026.** Method: fetched each project's README, docs and
official site, plus targeted web searches. **Source-code-level search was not
performed on any repository** — see Limitations.

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
| [microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit) | Partial — Cedar allow/deny, DLP attribute ratchets; PII masking not documented | **Yes** — Ed25519, Merkle-chained, `verify_receipt_chain()` | No |
| [Signet](https://github.com/Prismer-AI/signet) | Partial — policy bound into the receipt; no masking | **Yes** — Ed25519, hash-chained, offline | No |
| [Handshake.AI](https://handshake.ai/) | No | **Yes** — signed action receipts, DID-issued, offline | No |
| [hoophq/hoop](https://github.com/hoophq/hoop) | **Yes — strongest here.** ML-based masking before bytes leave the gateway | No — session recording/replay, no signed offline-verifiable artifact found | No |
| [Circe](https://github.com/wv26296-ux/circe-receipts) | No | **Yes** — Ed25519 + JCS, offline | No — explicitly out of scope |
| [VeritasActa/Acta](https://github.com/VeritasActa/Acta) | Partial — Cedar policy; masking not documented | **Yes** — Ed25519, 2 IETF Internet-Drafts, offline CLI | No |
| [agentreceipts.ai](https://agentreceipts.ai) | Different — parameters hashed, not masked | **Yes** — W3C VC + Ed25519, three SDKs cross-verify | No |
| [lasso-security/mcp-gateway](https://github.com/lasso-security/mcp-gateway) | **Yes** — Presidio PII masking, injection filters | No — no signing mechanism documented | No |
| [h33.ai](https://h33.ai/) | **Yes, and further** — FHE; the model never sees plaintext | **Yes** — ZK-STARK + Dilithium, verifiable "years later, offline, without the original vendor" | No |
| [CertNode](https://certnode.io/solutions/ai-agents) | Weak — no blocking gate | **Yes** — ES256 JWS + RFC 3161 | No |

The landscape splits cleanly. One camp enforces well but issues no portable evidence
(hoop.dev, Lasso). The other issues excellent portable evidence but does not enforce
before the model (Signet, Circe, Acta, agentreceipts, Handshake, CertNode). Two
projects do both — Microsoft's toolkit and h33.ai — and neither does the third.

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
   6 application numbers of a stated 10; the remainder are not public.
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
