---
title: "Transformation Evidence and Coverage Reconciliation for Auditable Data Disclosure"
abbrev: "Disclosure Evidence"
category: std

docname: draft-dogru-scitt-disclosure-evidence-02
submissiontype: IETF
number:
date:
consensus: true
v: 3
area: "Security"
workgroup: "SCITT"
keyword:
 - receipt
 - masking
 - reconciliation
 - transparency
 - disclosure

stand_alone: yes
pi: [toc, sortrefs, symrefs]

author:
 -
    fullname: Emek Can Doğru
    asciiFullname: Emek Can Dogru
    organization: VERAX TEKNOLOJİ LİMİTED ŞİRKETİ
    asciiOrganization: VERAX TEKNOLOJI LIMITED SIRKETI
    country: Turkey
    email: e.dogru@conarium.dev

normative:
  RFC2119:
  RFC8174:
  RFC8785:
  RFC9943:

informative:
  RFC7942:
  RFC9052:

--- abstract

Audit receipts for automated data access attest to what a gateway recorded.
Two questions remain outside their reach: what was changed in the data
before it was disclosed, and whether the set of receipts is complete with
respect to the data source's own accounting of activity. This document
defines two evidence structures that answer those questions:
Transformation Evidence, a per-disclosure statement of which classes of
values were transformed and how, carrying counts and class names but never
values; and Coverage Reconciliation, a procedure and result statement that
compares a source's own activity counters against a receipt set over a
time window and reports activity for which no receipt exists. Both
structures are designed to be registered as Signed Statements on a
Transparency Service as described in the SCITT architecture. This document
defines evidence payloads; it does not define a new receipt format, a new
transparency mechanism, or a new signature format.

--- middle

# Introduction

Systems that place a policy gateway between an automated client (for
example, an AI assistant) and a data source increasingly emit signed,
hash-chained access receipts. Several receipt formats exist. They share a
property that limits what they can prove: a receipt is evidence produced
by the party that performed the access, about an event that party chose to
record.

Two gaps follow from that property.

First, receipts typically state that access happened and under which
policy decision, but not what happened to the data between the source and
the client. When a gateway masks, redacts, or tokenizes values before
disclosure, that transformation is the substance of the privacy claim the
operator makes — and it is precisely the part a conventional receipt does
not describe. An auditor reading such a receipt learns that a table was
read, but not whether the protected columns in it left the gateway
transformed or in the clear.

Second, a set of receipts, however well chained and anchored, only covers
the accesses for which receipts were produced. A client that reaches the
data source without passing through the gateway produces no receipt, and
no property of the receipt chain reveals this. Hash chains detect removal
and reordering of records that exist; they are silent about records that
were never created. Establishing completeness requires a second account of
activity, produced by a party other than the gateway: the data source
itself.

This document defines two evidence structures addressing these gaps:

- Transformation Evidence ({{transformation-evidence}}): a statement,
  bound to a single disclosure, of which classes of values were
  transformed before disclosure, by which action, and in what count. It
  never carries the values themselves.

- Coverage Reconciliation ({{coverage-reconciliation}}): a procedure that
  compares snapshots of a data source's own activity counters, taken at
  the boundaries of a time window, against the receipt set for that
  window, and a signed result statement reporting activity patterns for
  which no receipt exists.

Both structures are payloads. They are intended to be carried in Signed
Statements and registered on a Transparency Service as described in the
SCITT architecture {{RFC9943}}, which supplies the append-only,
third-party-auditable registration this document deliberately does not
reinvent. This document defines no new receipt format, no policy
evaluation semantics, and no transparency mechanism.

## What these structures do not claim

Both structures are designed around a discipline of stating the limits of
their own evidence. Transformation Evidence describes the disclosure
surface; it does not claim a value is unlearnable
({{te-limits}}). A Coverage Reconciliation result reporting unreceipted
activity is a statement about absent evidence; it is not, and MUST NOT be
presented as, proof of intent or of a breach ({{cr-semantics}}).

# Conventions and Definitions

{::boilerplate bcp14-tagged}

The following terms are used throughout:

Data Source:
: The system holding the data, with its own accounting of query or access
  activity (for example, a database's statement statistics).

Gateway:
: The component that mediates access between an automated client and a
  Data Source, applies policy, transforms results, and emits receipts.

Disclosure:
: A single delivery of data (possibly transformed) from the Gateway to a
  client.

Receipt:
: A signed record of a Disclosure produced by the Gateway. This document
  is agnostic to the receipt format in use.

Protected Class:
: A named category of values that policy subjects to transformation (for
  example, "email", "national-id", "phone").

Window:
: A time interval over which reconciliation is performed, bounded by two
  snapshots of the Data Source's activity counters.

# Transformation Evidence {#transformation-evidence}

## Purpose

Transformation Evidence answers, for one Disclosure: which Protected
Classes were transformed in the disclosed result, by which action, and in
what count. It exists so that the transformation claim is a first-class,
signed, registrable artifact rather than prose in an operator's
documentation.

## Structure {#te-structure}

Transformation Evidence is a JSON object with the following members:

`v`:
: Structure version string. For this document: `transformation-evidence/1`.

`disclosure`:
: A digest binding this evidence to exactly one Disclosure, computed over
  the receipt for that Disclosure (or, where the receipt format defines a
  canonical record hash, that hash). Digest form is defined in
  {{digests}}.

`request`:
: A digest of the request that produced the Disclosure. The digest of the
  request, never the request text: query text can itself contain protected
  values.

`policy`:
: An object with `id` (an identifier of the policy version applied) and
  `decision` (the policy outcome under which disclosure proceeded).

`classes`:
: An array of objects, one per Protected Class that the applied policy
  recognizes and that occurred in the disclosed result, each with:

  `class`:
  : The Protected Class name, as named by the policy.

  `action`:
  : One of `mask`, `redact`, `tokenize`, `truncate`, or `none`. The value
    `none` states that the class occurred and was disclosed
    untransformed — an honest statement some deployments need to make.

  `count`:
  : The number of values of this class in the disclosed result to which
    the action was applied.

The structure MUST NOT carry data values, transformed or otherwise. Only
class names, action names, counts, digests, and identifiers appear. An
implementation encountering a value in a field defined here MUST reject
the structure.

## Serialization and digests {#digests}

For digesting and signing, the structure is serialized with the JSON
Canonicalization Scheme {{RFC8785}}. Digests in this document are SHA-256
and are written as strings prefixed with `sha256:` followed by lowercase
hexadecimal. Future documents may register alternative digest prefixes;
an implementation MUST reject a digest whose prefix it does not
recognize rather than guessing.

A CBOR/COSE serialization {{RFC9052}} of the same data model is expected
to be specified once the JSON model has received review; nothing in the
model depends on JSON specifically.

## What Transformation Evidence does not prove {#te-limits}

Transformation Evidence describes the disclosure surface of one result.
It does not state that a protected value is unlearnable by the client.
In particular, where the request language permits predicates over
protected columns, an allowed request can answer questions about a masked
value without the value ever being disclosed (a result-count of one
versus zero is one bit of the value). Transformation Evidence for such a
Disclosure is accurate — the value was transformed in the result — and
still compatible with the client having learned something about the
value.

Consumers MUST NOT present Transformation Evidence as proof of
non-exposure. It is proof of applied transformation, no more. A
deployment whose requirement is that a class be unlearnable rather than
hidden must enforce that requirement in policy (for example, by not
allowing the objects that carry the class at all); no evidence structure
substitutes for that enforcement.

The `classes` array is bounded by what the applied policy recognizes. A
value belonging to a class the policy does not name is not counted. The
absence of a class from the array is therefore a statement about the
policy's vocabulary as much as about the data, and MUST be read that way.

# Coverage Reconciliation {#coverage-reconciliation}

## Purpose

Coverage Reconciliation answers, for one Window: did the Data Source's
own accounting record activity for which no Receipt exists? It is the
mechanism by which "the gateway was bypassed" or "the receipt sink
failed" becomes detectable, rather than invisible.

The essential property is that the two accounts being compared originate
from different components: the receipt set from the Gateway, the activity
counters from the Data Source. A Gateway cannot make bypassed activity
disappear from an account it does not produce.

## Activity snapshots {#cr-snapshots}

A snapshot is a JSON object capturing the Data Source's cumulative
activity counters at a point in time:

`v`:
: Snapshot version string. For this document: `activity-snapshot/1`.

`ts`:
: The time the snapshot was taken (ISO 8601).

`source`:
: An identifier of the Data Source and the accounting scope within it
  (for example, the database role whose activity is counted). Both
  snapshots of a Window MUST carry the same `source`; a mismatch
  invalidates the Window.

`entries`:
: An array of objects, one per activity pattern the source's accounting
  distinguishes, each with:

  `pattern`:
  : A digest of the normalized activity pattern (for example, a
    normalized statement with constants removed). The digest, not
    necessarily the text: pattern text can embed protected values and
    schema detail. Deployments MAY retain pattern text privately for
    diagnosis; only the digest is required here.

  `count`:
  : The cumulative counter value for this pattern at `ts`.

## Reconciliation procedure {#cr-procedure}

Given a start snapshot, an end snapshot, and the receipt set for the
Window, a reconciler proceeds as follows.

Window validity is checked first. The two snapshots MUST carry the same
`v` and `source`, the end `ts` MUST be later than the start `ts`, and no
pattern's counter may be lower at the end than at the start. A counter
regression means the source's accounting was reset or altered inside the
Window; the Window is then unreliable, and the reconciler MUST report
failure for the Window as a whole rather than reconciling the surviving
patterns. An attacker who can reset counters must gain an error, not a
clean report.

For each pattern whose counter increased during the Window, the
reconciler attributes the pattern to the data objects it touches and
checks whether any Receipt in the Window covers access to those objects.
Matching is per pattern and per data object, not per call count: one
client-level request may legitimately produce more than one source-level
statement, so call counts and receipt counts MUST NOT be compared
one-to-one. A pattern whose target objects cannot be determined MUST NOT
be silently ignored; it fails the reconciliation with its own report.

Each active pattern receives one of three outcomes:

`covered`:
: At least one Receipt in the Window covers the objects this pattern
  touches.

`not-receipted`:
: No Receipt in the Window covers this pattern's objects.

`unattributable`:
: The pattern's target objects could not be determined.

The reconciliation as a whole succeeds only if every active pattern is
`covered`.

## Result statement {#cr-result}

The reconciliation result is a JSON object:

`v`:
: `coverage-reconciliation/1`.

`window`:
: Object with `start` and `end` (the two snapshot `ts` values).

`source`:
: The common `source` identifier of the two snapshots.

`snapshots`:
: Object with `start` and `end` digests of the two snapshot structures.

`receipts`:
: A digest identifying the receipt set that was compared (for chained
  receipt formats, the chain head digest and the sequence range are
  RECOMMENDED as the identifying material).

`outcome`:
: `covered`, `unreconciled`, or `invalid-window`.

`unreconciled`:
: When `outcome` is `unreconciled`: the list of pattern digests with
  outcome `not-receipted` or `unattributable`, each with its outcome.
  Pattern digests, not pattern text, for the reasons in
  {{cr-snapshots}}.

The result statement is serialized and digested as in {{digests}} and is
intended to be signed by the reconciling party and registered
({{scitt}}). The reconciler SHOULD be operationally independent of the
Gateway; where it is not, registration on a Transparency Service at
least makes the result's existence and timing third-party-visible.

## Semantics of "not receipted" {#cr-semantics}

A `not-receipted` outcome is a statement that evidence is absent, not a
statement about why. Gateway bypass, receipt sink failure, and accounting
scope mismatch all produce it. A result statement MUST NOT label
unreceipted activity as an intrusion, a breach, or an intentional act,
and consumers MUST NOT present it as such. The value of the mechanism is
precisely that it surfaces the condition; attributing cause is
investigation, not reconciliation.

Verification of receipt signatures and chain integrity is out of scope
for reconciliation and is assumed to have happened first, under the rules
of the receipt format in use. Reconciliation compares an
already-verified receipt set against source accounting; it does not
re-verify.

# Registration on a Transparency Service {#scitt}

Both structures defined here are payloads for Signed Statements in the
sense of the SCITT architecture {{RFC9943}}. An Issuer (the Gateway
operator for Transformation Evidence; the reconciling party for a
Coverage Reconciliation result) signs the serialized structure and
registers the Signed Statement on a Transparency Service, obtaining a
Receipt in the SCITT sense: proof of the statement's inclusion, at a
position, in an append-only log operated by a party other than the
Issuer.

This layering is deliberate. The structures in this document gain their
audit value from being registered somewhere the Issuer cannot quietly
rewrite; SCITT already defines that somewhere, together with its trust
model and verification procedures. This document therefore defines no
countersignature, no anchoring, and no log format of its own. Where this
document's mechanisms speak of digests binding evidence to receipts, the
binding survives registration unchanged: digests are over the payload,
not the envelope.

# Security Considerations

Same-operator collusion.
: In many deployments the Gateway and the Data Source are operated by the
  same party. Coverage Reconciliation's value against that party is
  reduced: an operator with administrative access to the source's
  accounting can suppress the counters themselves. The mandatory
  invalid-window rule ({{cr-procedure}}) turns counter resets into
  visible failures, and registration ({{scitt}}) makes suppression of
  already-issued results detectable, but an operator who controls both
  accounts and never registers anything is outside this mechanism's
  reach. Deployments needing assurance against the operator itself
  require an accounting path the operator cannot write to; that is a
  deployment property, not a payload property.

Counter manipulation.
: An attacker who can reset or rewind source counters could otherwise
  hide activity between snapshots. The MUST-fail rule exists for this
  case: a Window containing a regression is reported unreliable in its
  entirety. Snapshot frequency bounds the exposure — shorter Windows
  mean a reset costs the attacker a visible failure sooner.

Digest agility.
: Digests are prefixed ({{digests}}); an implementation MUST reject
  unknown prefixes. Accepting an unknown prefix as an opaque match would
  let an attacker route around comparison.

Signature and key compromise.
: Signing and registration are inherited from the SCITT layer; key
  management, revocation, and the consequences of Issuer key compromise
  are governed there, not here. A compromised Issuer key voids the
  evidentiary value of statements under that key, as it does for any
  signed artifact.

# Privacy Considerations

Every structure in this document was shaped by one rule: evidence about
protected data must not itself become a disclosure channel. Transformation
Evidence carries class names, action names, and counts — never values.
Request and pattern references are digests because query and pattern text
can embed values and schema detail. Class names and counts do reveal that
data of a class was present in a result in a given quantity; deployments
for which even that is sensitive can keep the payloads private and
register only their digests, at the cost of making third-party audit a
permissioned rather than public act.

# IANA Considerations

This document, if progressed, will request registration of two media
types: `application/transformation-evidence+json` and
`application/coverage-reconciliation+json`, with the structures of
{{te-structure}} and {{cr-result}} as their content. No registrations are
requested at this stage.

# Implementation Status

*This section is to be removed before publication as an RFC, per
{{RFC7942}}.*

One implementation of both mechanisms exists: the Conarium gateway
(TypeScript, MIT license, `@conarium-ai/core` on npm), in production at
one site since July 2026. Its receipts carry per-class masking counts as
in {{transformation-evidence}}; its `conarium-reconcile` tool implements
the procedure of {{cr-procedure}} against PostgreSQL statement
statistics, as a single file with no dependency on the package, so that a
third party can run the reconciliation without trusting the
implementation under audit. Its exit codes distinguish "covered",
"unreconciled activity", and "window unreliable" exactly as
{{cr-result}} does. Conformance test vectors ship with the package.

--- back

# Acknowledgments
{:numbered="false"}

The discipline of stating what each structure does not prove is owed to
every auditor who has been handed a green dashboard and asked to trust
it.
