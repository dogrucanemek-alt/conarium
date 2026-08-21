# Standards work

Internet-Draft sources authored from this codebase.

## draft-dogru-scitt-disclosure-evidence

Defines two evidence payloads for auditable data disclosure, designed to be
registered as Signed Statements on a SCITT (RFC 9943) Transparency Service:

- **Transformation Evidence** — a signed, per-disclosure statement of which
  protected classes were transformed before disclosure (action + count, never
  values). Implemented here as the receipt `masking` field.
- **Coverage Reconciliation** — a procedure and signed result comparing the
  data source's own activity counters against a receipt set over a window,
  surfacing activity for which no receipt exists. Implemented here as
  `conarium-reconcile`.

The draft defines payloads only: no new receipt format, no new transparency
mechanism, no new signature format.

**Status:** individual submission — an individual Internet-Draft, not an IETF
standard, and not adopted by a working group. An Internet-Draft is a dated
public record; it carries no formal standing. It is published so the receipt format can be implemented
without us. Which revision is posted is a Datatracker fact, not a sentence
this file should repeat:
<https://datatracker.ietf.org/doc/draft-dogru-scitt-disclosure-evidence/>
(`doc.json` is the machine-readable form of the same record).

**What `-03` added.** It corrects two overclaims found in review of `-02` on the
SCITT mailing list — a clean reconciliation described as coverage of the source
activity, and Transformation Evidence described as proof of the transformation
rather than the Issuer's assertion of it — and adds the outcome vocabulary,
mapping profiles, and exclusion rules that follow from that exchange.

**What `-04` added.** Review of `-03` on the list found that the Window boundary
is itself a bound and is decided by two clocks: the snapshot timestamps come
from the Data Source and a Receipt's timestamp from the Gateway. `-03` does
not say so — "clock", "skew" and "time source" do not appear in it — and an
item that is `observed-without-receipt` only because a Receipt fell outside
the Window is therefore reported as absent evidence, which is the outcome
whose semantics name gateway bypass. The same defect was found in the
implementation first, fixed in 0.2.27, attacked, and fixed again in 0.2.28.

**What `-05` added.** Its Implementation Status section was rewritten from
measurement against the published package rather than edited. Four statements in
`-04` described a tool that had moved past them — each understating what it does
— and nothing in the test suite compares that section against the code, so
nothing caught them. `-05` also states the temporal correspondence as three
named fields with an encoding (`clocks.observation`, `clocks.receipt`,
`clocks.skew`), after a second draft in this working group asked to adopt that
shape rather than invent a second one, and adds a security consideration on
receipt set completeness: a truncated receipt set verifies, detecting the
removal needs a quantity from outside it, and whether that quantity reached the
verifier independently of the Issuer is not visible in a digest.

**What `-06` added.** A section placing this document against coverage
attestation, a second layer under discussion on the list. The two compose in one
direction and substitute in neither: an attestation over a mediated examination
inherits whatever the mediator's record leaves open, and inherits it silently
unless the record says so. Its Implementation Status is measured against the
published 0.2.38 package and is now *checked* rather than measured once — every
behavioural statement is bound to a run of the shipped reconciliation tool over a
fixture the document names, enforced in both directions, since a statement with
no run is one nothing measures and a run with no statement is a measurement the
document dropped. The revision under test is derived from what the repository
holds rather than named in the check, a hard-coded revision being the same class
of stale declaration the check exists to catch. The first thing it caught was
`-05`'s own sentence saying no such check existed; a posted draft cannot be
edited, so the correction lives here. `-06` also states why the result carries
`matched` as a count rather than an accounting — the result digests both
activity snapshots and the receipt set, so a reader recomputes the matched set
instead of being told its size — and names the one case where that standing
fails: where the identifying material was read from the receipt set itself, a
reader recomputes the Issuer's answer, and the digest checks transcription
rather than completeness.

This file has been wrong before when it copied posting status. The Datatracker
link above is the check; a revision history in this paragraph is not.

Source is kramdown-rfc markdown. To build txt/xml locally:

```
gem install kramdown-rfc
pip install xml2rfc
kramdown-rfc standards/draft-dogru-scitt-disclosure-evidence-03.md > draft.xml
xml2rfc --text draft.xml -o draft.txt
```

On Windows, `xml2rfc` imports WeasyPrint at startup and fails if its GTK libraries
are absent. WeasyPrint is only needed for PDF output; uninstalling it lets the text
and XML paths work.

or paste the file into <https://author-tools.ietf.org/>.
