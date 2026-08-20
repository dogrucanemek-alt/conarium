---
title: "Transformation Evidence and Coverage Reconciliation for Auditable Data Disclosure"
abbrev: "Disclosure Evidence"
category: std

docname: draft-dogru-scitt-disclosure-evidence-05
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
    country: TR
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
time window and classifies what the comparison establishes. The
reconciliation result distinguishes what was matched under a declared
correspondence from what was observed without a receipt, receipted without
a corresponding observation, excluded before comparison, or left
indeterminate; it does not report a bare pass. Both structures are designed
to be registered as Signed Statements on a Transparency Service as
described in the SCITT architecture. This document defines evidence
payloads; it does not define a new receipt format, a new transparency
mechanism, or a new signature format.

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
  window, and a signed result statement classifying each item of either
  account. The comparison is between two populations, neither assumed
  complete, under a correspondence the operator declares ({{cr-mapping}});
  the result distinguishes what was matched from what was observed without
  a receipt, receipted without an observation, excluded before comparison,
  or left undecided.

Both structures are payloads. They are intended to be carried in Signed
Statements and registered on a Transparency Service as described in the
SCITT architecture {{RFC9943}}, which supplies the append-only,
third-party-auditable registration this document deliberately does not
reinvent. This document defines no new receipt format, no policy
evaluation semantics, and no transparency mechanism.

## What these structures do not claim

Both structures are designed around a discipline of stating the limits of
their own evidence. Transformation Evidence describes the disclosure
surface; it does not claim a value is unlearnable, and it is the Issuer's
signed assertion that a transformation was applied rather than proof that
it was ({{te-limits}}). A Coverage Reconciliation result reporting activity
without a receipt is a statement about absent evidence; it is not, and MUST
NOT be presented as, proof of intent or of a breach ({{cr-semantics}}).

Neither structure reports a bare pass. A reconciliation computed against an
operator-declared correspondence cannot yield an outcome stronger than that
declaration ({{cr-mapping}}), and an outcome the evidence does not decide
is reported as undecided rather than folded into a proportion.

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
  snapshots of the Data Source's activity counters. Both bounds are stamped by
  the Data Source; whether a Receipt falls inside them is a question about a
  second clock, the Gateway's ({{cr-procedure}}).

Mapping Profile:
: A versioned statement, declared by the operator, of the correspondence
  expected between one client-level operation and the source-level activity
  it produces — including the bound on that multiplicity, the clock source on
  each side and the skew bound between them, and the rules by which activity
  is excluded from comparison. A Mapping Profile is a
  declaration about a deployment, not a measurement performed by the
  Gateway ({{cr-mapping}}).

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
non-exposure. Nor is it proof that the transformation was applied: the
payload is a signed assertion by the Issuer that it was. Unless a Verifier
independently establishes that the disclosed bytes carry the transformation
the Issuer describes, the evidence available is evidence of what the pinned
Issuer asserted. Where the Issuer is the Gateway that performed the
transformation, that assertion is self-attested, and a consumer who treats
it as verified has removed the Issuer from the trust statement without
replacing it with anything. A deployment whose requirement is that a class
be unlearnable rather than hidden must enforce that requirement in policy
(for example, by not allowing the objects that carry the class at all); no
evidence structure substitutes for that enforcement.

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

Window membership is itself a bound, and it is decided across two clocks. The
snapshot timestamps are taken by the Data Source; a Receipt's timestamp is
written by the Gateway. Admitting Receipts on an exact comparison between them
makes the failure asymmetric: a Gateway clock trailing the Data Source moves a
Receipt that names the object out of the Window, and the object it would have
accounted for becomes activity for which no Receipt exists. That outcome is the
one whose semantics name gateway bypass ({{cr-semantics}}), so a clock
difference of seconds can produce the accusation rather than any real gap. The
difference measured where this was found was three seconds; nothing in the
procedure sets a floor below which it stops happening, and a smaller one is
correspondingly harder for a reader to suspect.

A Mapping Profile therefore declares the clock source on each side and the skew
bound between them, as it declares multiplicity ({{cr-mapping}}), and both are
covered by the profile digest as every other part of it is. Where the bound is
undeclared, the rule below applies and the affected items are `indeterminate`
rather than absent evidence. Where it is declared and a Receipt falls further
outside the Window than the bound allows, the boundary does not explain it: the
item takes the outcome it would have had, and a reconciler MUST report which
bound it applied to reach that.

For each pattern whose counter increased during the Window, the
reconciler attributes the pattern to the data objects it touches and
checks whether any Receipt in the Window names those objects. Matching is
per pattern and per data object, not per call count: one client-level
request may legitimately produce more than one source-level statement, so
call counts and receipt counts MUST NOT be compared one-to-one. A pattern
whose target objects cannot be determined MUST NOT be silently ignored; it
receives the `indeterminate` outcome below.

The comparison is between two populations — source-level activity and
Receipts — and neither population is assumed complete. Each item in either
population receives exactly one of the following outcomes:

`matched`:
: The item corresponds to an item in the other population within the
  bounds of the applicable Mapping Profile ({{cr-mapping}}), and within the
  Window. The profile's two kinds of bound do not act alike here: a
  multiplicity bound admits items to this outcome, and the skew bound does
  not. A Receipt outside the Window is never `matched`, however small the
  declared skew — the bound qualifies how far the boundary can be trusted, not
  where the boundary is.

`observed-without-receipt`:
: The Data Source recorded activity against an object that no Receipt in
  the Window names.

`receipted-without-observation`:
: A Receipt in the Window names an object for which the Data Source's
  counters record no activity.

`excluded`:
: The item was removed from comparison before matching by a rule stated in
  the Mapping Profile ({{cr-exclusions}}).

`indeterminate`:
: The evidence or the Mapping Profile does not determine an outcome — the
  pattern's objects could not be attributed, a required multiplicity or skew
  bound is undeclared, the item's only naming Receipt falls outside the Window,
  or the Window's evidence is insufficient to decide.

An implementation MUST NOT report an item as `matched` when the outcome is
`indeterminate`; the absence of a decision is not a decision. In
particular, where a Mapping Profile does not declare the multiplicity bound
that the comparison requires, the affected items are `indeterminate` and
not clean coverage.

The same rule binds the temporal bound, in the opposite direction. Where every
object an item leaves unaccounted for is named by a Receipt that falls outside
the Window, the item is `indeterminate`, and an implementation MUST NOT report
it as `observed-without-receipt`. A reconciler cannot distinguish a Gateway
clock that trails the Data Source from a Receipt written late, and reporting
absent evidence asserts a distinction it did not make. An item that leaves even
one object named by no Receipt at all is not affected by this rule: that is a
genuine absence, and a neighbouring object's clock does not make it
undecidable.

`indeterminate` here is not a weaker pass. The comparison did not come out
clean, and a result statement MUST carry the outcome and the offset that
produced it. What the implementation is forbidden to do is state the cause.

A reconciliation with no `observed-without-receipt` items establishes that
each observed source-level item is attributable to a Receipt naming the
same object, under the declared correspondence. It does not establish that
every source-level statement was itself receipted, and a result MUST NOT be
stated in terms that assert it. Where one Receipt naming an object clears
an unbounded number of further statements against that object inside the
Window, the procedure has established object attribution and nothing
stronger.

## Mapping profiles {#cr-mapping}

One client-level operation may produce several source-level statements. The
multiplicity is not a property of the Gateway; it is a property of the
deployment — the version of the intermediary in front of the Data Source, a
connection pooler, an object-relational mapper. A Gateway cannot measure a
correspondence it does not produce.

A Mapping Profile is therefore declared by the operator. It states, for each
client-level operation it covers, the expected bounded set of source-level
patterns, the bound on their multiplicity, and the exclusion rules applied
before comparison ({{cr-exclusions}}). It carries a version identifier and
is serialized and digested as in {{digests}}.

The profile also declares the temporal correspondence, for the same reason it
declares the multiplicity one: the operator knows it and the Gateway cannot
measure it. It states the clock source on each side — the one the Data Source
stamps snapshots with, and the one the Gateway stamps Receipts with — and the
skew bound between them. Both are operator statements and carry that standing
under the rule below, including a declaration that the two sides read one clock
and the bound is therefore zero. That declaration is still a declaration: one
clock read twice is not read at the same instant, and whether the residue
matters is a judgement about the deployment. What the rule below forbids is
presenting it as measured, and what this document refuses is the third case —
zero because nobody looked, declared by nobody, and read by the reconciler as
agreement.

The temporal correspondence is declared in three fields, under a `clocks`
member of the profile. They are given here with their encoding so that a
specification defining a different mapping structure can adopt the same shape
rather than a second one:

`clocks.observation`:
: String. An identifier for the clock that stamps the activity snapshots — the
  Data Source side.

`clocks.receipt`:
: String. An identifier for the clock that stamps Receipts — the Gateway side.

`clocks.skew`:
: Duration. The bound on how far those two clocks may differ. A duration is a
  decimal integer with a unit suffix of `ms`, `s`, `m`, or `h`, or a bare
  decimal integer read as milliseconds: `500ms`, `5s`, `2m`, `1h`, `5000`. A
  duration that does not parse is an error, not a default.

An implementation MUST reject a `clocks` member carrying any key other than
these three, and SHOULD name the key it rejected. A profile whose fourth field
is silently ignored declares less than its author believes it declares, and the
difference surfaces as an outcome the operator cannot account for.

A declaration that both sides read one clock writes all three fields: the two
identifiers may be the same string, and `skew` may be `0ms`. A declared zero is
a statement someone is accountable for; an assumed zero is the condition the
rule below forbids.

Where the skew bound is declared twice — in the profile and through an
interface of the reconciler's own — an implementation MUST NOT select between
them. Two declarations that parse to the same number of milliseconds are one
declaration and proceed. Two that do not are an operator error and MUST fail,
because which declaration prevailed would not be visible on the result, and a
bound whose origin cannot be read from the result is not usefully declared at
all.

A reconciliation result computed against a Mapping Profile MUST bind that
profile's digest, and MUST state, for each bound it relies on, whether the
bound is protocol-defined, measured, operator-declared, or undeclared. A
result MUST NOT present an operator-declared bound as a measured one.

The consequence is a ceiling: **a coverage outcome computed against a
declared correspondence cannot be stronger than the declaration.** Where the
declaration is an operator statement, the outcome inherits that standing and
the result statement is required to show it. This is the same discipline
this document applies to absent evidence in {{cr-semantics}}, one layer up:
a declaration presented as a measurement is an overclaim regardless of
whether the declaration happens to be true.

Where a required multiplicity bound is undeclared, the affected items are
`indeterminate` ({{cr-procedure}}). An implementation MUST NOT substitute a
default bound of one; a one-to-one rule reports false
`observed-without-receipt` items on any deployment with a pooler in front of
the Data Source, and a silent default would make that error look like a
finding.

An undeclared skew bound is treated the same way, and for the same reason. An
implementation MUST NOT substitute a default of zero: zero asserts that the two
clocks agree, which is the assumption that produces the false accusation this
document now guards against. It MUST NOT substitute a bound of its own choosing
either, which would decide the operator's question with a number the operator
never saw. Absent the declaration, items whose only naming Receipt sits outside the
Window are `indeterminate` and the result reports the offset, leaving the
reader to compare it against clocks the reader knows and the reconciler does
not.

An implementation MAY, absent a declared bound, decline to offer the boundary
as the explanation for an offset larger than the Window itself, on the ground
that a boundary artefact cannot exceed the interval it bounds. This is a
reporting choice about what an implementation is willing to suggest, not a
change of outcome: the item is `indeterminate` either way.

## Exclusions {#cr-exclusions}

Exclusion differs from the other outcomes in kind. `matched`,
`observed-without-receipt`, `receipted-without-observation`, and
`indeterminate` are produced by the comparison. `excluded` is a decision
taken before it, about what will be compared at all. It is therefore the
outcome through which a reconciliation can be made to come out clean, and it
requires the tightest reporting rules of the five.

Exclusion rules MUST be stated in the Mapping Profile and are therefore
covered by its digest. A result statement MUST report the count of excluded
items and the rule that excluded each of them. An implementation MUST NOT
exclude items by a rule that is not in the profile.

Without these constraints, a clean result and a result cleaned by exclusion
are indistinguishable to a reader, and the digest that is supposed to pin
what was compared does not cover the step that decided what was compared.
Session or catalog housekeeping is a legitimate exclusion; the requirement
is not that exclusions be rare, but that they be visible and pinned.

The boundary of what pinning achieves is worth stating, because it is easy to
read as more. Carrying the rule identifier makes the exclusion *reproducible*:
a reader can see which rule removed each item and confirm that the rule was in
the profile the digest covers. It does not establish that the exclusion was
*correct*. A rule that removes session housekeeping and a rule that removes the
very statements an auditor came to examine are pinned identically and verify
identically; the mechanism reproduces the decision, it does not judge it.
Consumers MUST NOT read a pinned exclusion as a justified one, and a result
statement MUST NOT present the digest as evidence that the exclusions were
appropriate. This is the same distinction this document draws between a
declared bound and a measured one ({{cr-mapping}}), applied to the step that
decides what is compared at all.

## Result statement {#cr-result}

The reconciliation result is a JSON object:

`v`:
: `coverage-reconciliation/2`. The outcome vocabulary of
  `coverage-reconciliation/1` is not a subset of this one: a `/1` result
  reporting `covered` asserts more than the procedure establishes, and is
  not re-expressible here. A consumer MUST NOT read a `/1` result as a `/2`
  result.

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
: A result SHOULD state whether that identifying material was obtained
  independently of the Issuer or read from the receipt set itself. The two
  are not equivalent evidence, and a Consumer cannot tell them apart from
  the digest ({{sec-completeness}}).

`profile`:
: The digest and version identifier of the Mapping Profile the comparison
  was computed against ({{cr-mapping}}), or `null` when none was declared.
  When `null`, every item whose outcome depends on a multiplicity bound is
  `indeterminate`, and so is every item whose only naming Receipt falls
  outside the Window: with no profile there is no declared skew bound either.

`bounds`:
: For each bound the comparison relied on, its source: `protocol-defined`,
  `measured`, `operator-declared`, or `undeclared`. A result whose bounds
  are `operator-declared` states an outcome of that standing, no stronger.

`outcome`:
: `invalid-window` when the Window is unreliable ({{cr-procedure}});
  otherwise `no-exceptions` when every item is `matched` or `excluded`, and
  `exceptions` when any item is `observed-without-receipt`,
  `receipted-without-observation`, or `indeterminate`.
: The name states what the comparison left open, not what it proved. A
  result MUST NOT carry an outcome name that asserts coverage of the source
  activity, and `no-exceptions` is not such an assertion: it says the
  comparison produced no open item under the declared correspondence, which
  is bounded by that correspondence ({{cr-mapping}}) and by the fact that
  neither population is assumed complete.

`items`:
: The list of items whose outcome is not `matched`, each with its outcome
  and, for `excluded`, the profile rule that excluded it. Pattern digests,
  not pattern text, for the reasons in {{cr-snapshots}}.

`counts`:
: The number of items in each outcome, including `matched` and `excluded`.
  An implementation MUST NOT aggregate `indeterminate` items into a
  proportion of coverage: an outcome that does not decide cannot be
  averaged into one that does, and reporting it as a percentage restores
  precisely the overclaim this vocabulary exists to prevent.

The result statement is serialized and digested as in {{digests}} and is
intended to be signed by the reconciling party and registered
({{scitt}}). The reconciler SHOULD be operationally independent of the
Gateway; where it is not, registration on a Transparency Service at
least makes the result's existence and timing third-party-visible.

## Semantics of the outcomes {#cr-semantics}

An `observed-without-receipt` outcome is a statement that evidence is
absent, not a statement about why. Gateway bypass, receipt sink failure,
and accounting scope mismatch all produce it. So does a Receipt that exists
and names the object but carries a timestamp the Window's own two clocks put
outside it — which is why {{cr-procedure}} removes that case from this outcome
rather than listing it as one more cause. It is named here because the earlier
revision of this document listed the mirror condition under
`receipted-without-observation` and not this one, and a reader comparing the
two lists should see that the omission was corrected rather than assume the
boundary distorts only one direction. A result statement MUST NOT
label such activity as an intrusion, a breach, or an intentional act, and
consumers MUST NOT present it as such. The value of the mechanism is
precisely that it surfaces the condition; attributing cause is
investigation, not reconciliation.

A `receipted-without-observation` outcome is likewise a statement about
evidence, and it is not by itself a fault. A counter reset at the Window
boundary, an intermediary that collapses statements, and an increment that
lands outside the snapshot pair all produce the same shape as a receipt
describing activity that did not occur. An implementation MAY treat it as a
failure condition under a policy of its own; this document does not define
it as one, because the shape does not distinguish the cases.

An `indeterminate` outcome is a result, not a degraded pass. It MUST NOT be
resolved by assumption in either direction: neither counted as matched
because nothing contradicts it, nor reported as missing activity because
nothing confirms it. An implementation under pressure to produce a single
number will be tempted to fold `indeterminate` into a coverage proportion;
that operation destroys the only property that distinguishes this
vocabulary from a bare pass, and MUST NOT be performed.

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

Declared correspondence as an attack surface.
: The Mapping Profile ({{cr-mapping}}) is written by the operator, and it
  decides both what counts as a match and what is excluded before matching.
  An operator who can widen a multiplicity bound can absorb unreceipted
  activity into an expected range; one who can add an exclusion rule can
  remove it from comparison entirely. This mechanism does not defend
  against that operator — nothing computed against a declaration can. What
  it does is make the declaration part of the evidence: the profile is
  versioned, its digest is bound into the result, exclusions are reported
  with their count and rule, and the result states that its bounds are
  operator-declared. A reader who trusts the result inherits a visible
  dependency on the profile rather than an invisible one. Registration
  ({{scitt}}) makes the sequence of profiles an operator has declared
  third-party-visible, which is the property a silently edited profile
  would otherwise remove.

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

## Receipt set completeness and where the expected count comes from {#sec-completeness}

A receipt set whose most recent entries have been removed is internally
consistent. Every remaining link verifies, every signature checks, and nothing
in the file states how many entries it should have contained. Reconciliation
does not close this: it compares the receipt set against source accounting, and
an operator who can truncate the one can generally suppress the other. Detecting
the removal requires a count, a head digest, or an equivalent quantity that does
not come from the truncated file.

What matters to a Consumer is not that such material exists but where it
arrives from, and the two available constructions differ in a way a digest does
not reveal.

An implementation may accept the expected quantity as an input to its verifier.
The check then works exactly as well as the input is trustworthy, and an auditor
holding only the receipt file has no source for it except the Issuer — the party
whose behaviour is being examined. The verification is real; its independence is
supplied by whoever ran it, and is not a property of the artifacts.

An implementation may instead carry the quantity inside the signed material, so
that the set testifies to its own extent. This closes the gap the first
construction leaves open, at a cost that should be stated: the Issuer is now
signing an assertion about a population it has not finished producing, and a
counter carried per entry constrains only the entries that were kept unless the
format also seals a total. A running count that is derived from the sequence
number it accompanies adds no information at all — it restates the position of
a record that is present, and says nothing about one that is absent. The
property worth having is a sealed quantity over a set held by someone, not a
per-record decoration.

This document requires neither construction. It requires that a result
identifying a receipt set be readable as to which one it relied on, because a
Consumer who cannot tell the difference will read an externally supplied pin as
though the receipt set had proved its own completeness, which is the strongest
claim in this area and the one least often actually made.

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
implementation under audit. Conformance test vectors ship with the package.

The state below was measured against the published 0.2.37 package rather than
read from its documentation. Every revision of this section up to -04 described
an implementation that had moved past it, in the direction of claiming less
than the code did; the correction is recorded at the end of this section
because the failure is more instructive than the current state.

As of 0.2.37 the tool emits the result statement of {{cr-result}} as
`coverage-reconciliation/2`, on a flag of its own. The `/1` body is unchanged
and still carries `conarium-reconcile/0.1`. The `/2` result carries `profile`,
`bounds`, `outcome`, `items`, and `counts` under the names used here, and reads
Mapping Profiles ({{cr-mapping}}) including the three `clocks` fields.

The behaviour below was observed on one fixture: a Receipt naming the object,
timestamped three seconds before a two-hour Window, together with one
infrastructure statement.

- With no profile, `profile` is `null`, all three entries in `bounds` are
  `undeclared`, and both items are `indeterminate` — the data statement for
  want of a declared skew bound, the infrastructure statement for want of a
  declared exclusion rule. In the `/2` result the tool applies no exclusion
  rule that is not in a profile, which is the requirement of
  {{cr-exclusions}}. Its `/1` output still reports such statements under a
  category of its own, decided by rules built into the tool; that output is
  not a result statement in the sense of {{cr-result}} and does not claim to
  be.
- With a profile declaring exclusions but no `clocks` member, the excluded item
  carries the profile rule that removed it, `bounds.exclusion` is
  `operator-declared`, and `bounds.skew` remains `undeclared`.
- With `clocks.skew` declared larger than the offset, `bounds.skew` is
  `operator-declared` and the item remains `indeterminate`. A declaration does
  not manufacture a match.
- With `clocks.skew` declared smaller than the offset, the same item becomes
  `observed-without-receipt`. The declared bound reaches the comparison and not
  only the report.
- A skew bound declared both in a profile and through the command line fails
  unless the two parse to the same number of milliseconds; a `clocks` member
  carrying a fourth key fails and names the key it rejected.

Two gaps remain. The tool's exit codes predate this vocabulary and are still
not a mapping of it; they were left unchanged deliberately, because an exit
code is a compatibility contract with running deployments and renumbering them
to match a revision of this document would break installations in order to make
a specification look implemented. One code was added rather than renumbered,
for the temporal outcome, which existing callers do not notice.

The second gap is the one that produced this section's own history. The
implementation's test suite contains no check that compares this section
against what the code does. Each of the four statements this revision removed
was accurate when written and false within days, and none was found by any
mechanism — they were found by a reader holding the document beside the tool's
output. A gaps section that goes stale understating an implementation fails in
the same way as one that overstates it: both describe a system that does not
exist, and a reader has no way to know which direction the error runs. Until
that check exists, this section should be read as a claim about the date it was
measured.

Earlier revisions of this document, and releases of that implementation up
to 0.2.21, described a clean reconciliation as "covered". That word asserted
more than the procedure establishes; it was corrected in the implementation
in 0.2.22 and in this document in -03.

The temporal rule added in -04 has the same history, compressed. The
implementation admitted Receipts on an exact comparison across the two clocks,
so a Receipt three seconds outside a two-hour Window produced
`observed-without-receipt` and a message about a possible bypass. That was
raised in review of -03 on the SCITT mailing list, reproduced, and corrected in
0.2.27. The correction was then attacked: a Receipt from the previous day,
naming the same object, moved a real in-Window absence into the new outcome and
the implementation offered the boundary as its explanation — an exculpation a
twenty-three hour offset cannot support. 0.2.28 bounds what the implementation
is willing to suggest, which is the reporting choice described in
{{cr-mapping}}. Both defects were in the implementation before they were visible
in this document, and neither was found by reading it. The first came from
review of -03 on the mailing list; the second from an adversarial review of the
implementation, commissioned because the fix had loosened a default and its
author was not the party who should clear it. What made the second sentence
sayable was the tool's own output, not this text, which did not yet exist. The
document's part was smaller and later: it is where the correction has to be
written down so the next implementation does not have to be attacked to learn
it.

--- back

# Acknowledgments
{:numbered="false"}

The discipline of stating what each structure does not prove is owed to
every auditor who has been handed a green dashboard and asked to trust
it.

Iman Schrock reviewed revision -02 on the SCITT mailing list and identified
two overclaims in it: that a clean reconciliation established coverage of
the source activity, and that Transformation Evidence proved the
transformation rather than the Issuer's assertion of it. Both were corrected
in -03. The outcome vocabulary of {{cr-procedure}} and the
requirement that a declared bound cannot yield an outcome stronger than the
declaration follow from that exchange. Reviewing -03, the same reviewer
established that an item whose classification rule does not resolve under the
pinned profile is `indeterminate` rather than excluded — the rule -04
applies one layer up, to bounds.

Walter Hawkins read the reconciliation implementation and found the temporal
defect -04 exists to correct: that Window membership is decided
across two clocks, that admitting Receipts on an exact comparison between them
manufactures an accusation where no gap exists, and that the failure is
asymmetric in the direction that produces false findings rather than missed
ones. The observation that the sub-second case is the dangerous one — being the
one a reader will believe — is his, and it is why {{cr-procedure}} sets no floor
below which the problem is assumed to stop. The requirement that a source
population declare its own completeness on the same standing ladder as every
other bound is also his.

Joel Hillier, reviewing -04 on the SCITT mailing list, asked that the temporal
correspondence be given as named fields with a stated encoding rather than
described in prose, so that another specification could adopt the same shape
instead of inventing a second one. The three `clocks` fields in {{cr-mapping}}
are written to be copied, and are the answer to that request. The observation
that a gaps section going stale in the understating direction is the same
failure as one that overstates is also his; it is why the Implementation Status
section of this revision was rewritten from measurement rather than edited.

Henri Sirkkavaara established the distinction in {{sec-completeness}} between an
expected quantity supplied to a verifier from outside and one carried inside the
signed material, by building the second and naming what the first leaves an
auditor unable to do. The consequence is stated against this document's own
implementation, which does the first. The narrower observation that a running
count derived from the sequence number it accompanies adds no information is
this author's, arrived at while measuring his, and is recorded here because it
bears on the construction rather than on the distinction, which stands.
