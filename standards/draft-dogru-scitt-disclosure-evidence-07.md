---
title: "Transformation Evidence and Coverage Reconciliation for Auditable Data Disclosure"
abbrev: "Disclosure Evidence"
category: info

docname: draft-dogru-scitt-disclosure-evidence-07
submissiontype: IETF
number:
date:
consensus: false
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
  RFC6838:
  RFC8126:
  RFC8785:
  RFC9943:

informative:
  RFC7942:
  RFC8032:
  RFC9052:
  I-D.farley-acta-signed-receipts:
  I-D.marques-asqav-compliance-receipts:
  I-D.chueayen-attestation-receipts:
  I-D.aylward-aiga-2:

--- abstract

Audit receipts record what a gateway wrote about an access. They omit how
data changed and whether every access left a receipt. This document defines
two evidence payloads for those gaps. Transformation Evidence states which
value classes were transformed, and how, without carrying values. Coverage
Reconciliation compares source activity counters with a receipt set over a
window. Each item is matched, observed without a receipt, receipted without
an observation, excluded, or indeterminate. The result is not a bare pass.
Both payloads register as Signed Statements on a SCITT Transparency
Service. This document defines no new receipt format, transparency
mechanism, or signature format.

--- middle

# Introduction

Systems place a policy gateway between an automated client and a data
source. Those systems increasingly emit signed, hash-chained access
receipts. Several receipt formats exist. They share a limit. A receipt is
evidence from the party that performed the access. It is about an event
that party chose to record.

Two gaps follow from that property.

First, receipts typically state that access happened. They name the policy
decision. They do not say what happened to the data between the source and
the client. A gateway may mask, redact, or tokenize values before
disclosure. That transformation is the privacy claim. A conventional
receipt does not describe it. An auditor learns that a table was read.
The auditor does not learn whether protected columns left the gateway
transformed or in the clear.

Second, a receipt set only covers accesses that produced receipts. A
client that reaches the data source without the gateway produces no
receipt. The receipt chain does not reveal this. Hash chains detect
removal and reordering of records that exist. They are silent about
records that were never created. Completeness needs a second account of
activity. That account comes from a party other than the gateway: the
data source.

This document defines two evidence structures for these gaps.

- Transformation Evidence ({{transformation-evidence}}): a statement bound
  to one disclosure. It names which classes of values were transformed,
  by which action, and in what count. It never carries the values.

- Coverage Reconciliation ({{coverage-reconciliation}}): a procedure and a
  signed result. It compares source activity snapshots at the window
  bounds with the receipt set for that window. It classifies each Item of
  either account. Neither population is assumed complete. The operator
  declares the correspondence ({{cr-mapping}}). The result names what was
  matched, observed without a receipt, receipted without an observation,
  excluded, or left undecided.

Both structures are payloads. They are meant to be Signed Statements on a
Transparency Service as in {{RFC9943}}. SCITT supplies append-only,
third-party-auditable registration. This document does not reinvent that.
This document defines no new receipt format, no policy evaluation
semantics, and no transparency mechanism.

Other individual drafts record signed decisions about automated access.
Farley {{I-D.farley-acta-signed-receipts}}, Marques
{{I-D.marques-asqav-compliance-receipts}}, and Chueayen
{{I-D.chueayen-attestation-receipts}} use Ed25519 {{RFC8032}} and JSON
Canonicalization {{RFC8785}}. Aylward {{I-D.aylward-aiga-2}} uses Ed25519
in a hybrid signature suite and does not specify JCS. None of those drafts
defines Transformation Evidence or Coverage Reconciliation.

## Threat model and applicability {#threat-model}

The full account is in {{security}}. This subsection states the bound so a
reader meets it before the procedure.

The Gateway and the Data Source are often run by one party. That party can
suppress the source counters. A counter reset must fail the Window
({{cr-procedure}}). It must not yield a clean report. The Mapping Profile
is written by the Gateway operator. It can absorb unreceipted activity or
exclude it. The defence is visibility: a digest-bound profile, reported
exclusions, and a stated standing for each bound. Digests reject unknown
prefixes. Issuer key compromise is a SCITT-layer problem. A truncated
receipt set still verifies internally; detecting the cut needs a quantity
from outside that file ({{sec-completeness}}).

## What these structures do not claim

Both structures state the limits of their own evidence. Transformation
Evidence describes the disclosure surface. It does not claim a value is
unlearnable. It is the Issuer's signed assertion that a transformation
was applied, not proof that it was ({{te-limits}}). A Coverage
Reconciliation result that reports activity without a receipt is a
statement about absent evidence. It is not, and MUST NOT be presented as,
proof of intent or of a breach ({{cr-semantics}}).

Neither structure reports a bare pass. A reconciliation against an
operator-declared correspondence cannot be stronger than that declaration
({{cr-mapping}}). An undecided outcome is reported as undecided. It is
not folded into a proportion.

## Relationship to coverage attestation

A record can be intact and silent about what is missing. A report can be
complete and silent about what it examined. These are two failures. They
close in different places.

This document is about the first. It states what a mediator recorded. It
states what that record leaves open. A chain that verifies says nothing
about entries that were never written. The vocabulary here lets a record
say so in its own terms.

The second belongs to coverage attestation. An examination declares the
population it drew from. It names the basis for that population. It
accounts for every unit it did not examine. Work on that layer is under
way on this list.

The two compose in one direction. They substitute in neither. A coverage
attestation states what was examined. The structures here state what the
mediator recorded of it. An attestation over a mediated examination
inherits whatever the mediator's record leaves open. It inherits that
silently unless the record says so. That silence is the failure this
document names. The other way is no rescue either. A complete access
record over a population chosen after the results were known is an exact
record of a decided question.

Neither layer rescues the other. One artefact answers half of a two-part
question.

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

Item:
: One unit the reconciliation procedure classifies. On the source side,
  one snapshot entry whose pattern counter increased in the Window — one
  pattern, not one (pattern, Data Object) pair. On the receipt side, one
  Receipt that names a Data Object the snapshots do not account for.
  Counting each (pattern, Data Object) pair as an Item changes
  `observed-without-receipt`.

Data Object:
: A named target of source activity or of a Receipt. In the shipped
  reconciler this is a table (or equivalent schema object), not a column.
  The result records these as `objects` on an Item.

Consumer:
: A party that reads Transformation Evidence or a Coverage Reconciliation
  result and presents it to a human or to another system. This document
  uses Consumer for that role.

Reconciler:
: The party that performs Coverage Reconciliation and produces the result
  statement. This document uses Reconciler for that role.

Protocol-defined:
: A standing this document itself assigns to a bound. Example: the
  invalid-window rule. It is not a measurement.

Measured:
: A standing a bound has when it was obtained by observation of the
  deployment. It is not operator-declared and not assigned by this
  document.

Client-level operation:
: One Disclosure, or one client request as seen by the Gateway.

Source-level statement:
: One increment of a Data Source activity counter. That is one snapshot
  entry for one pattern. It is not interchangeable with a Client-level
  operation.

Gateway operator:
: The party that operates the Gateway.

Data Source operator:
: The party that operates the Data Source. This document does not use
  "the operator" without saying which. Where both are the same party,
  {{security}} states the limit.

Issuer:
: In the sense of {{RFC9943}}: the party that signs a Signed Statement.
  For Transformation Evidence that is the Gateway operator. For a
  Coverage Reconciliation result that is the Reconciler.

Verifier:
: A party that checks a signature, a digest, or a Transparency Service
  receipt. This document uses the term once, for independent checking of
  a disclosed result against the Issuer's Transformation Evidence
  assertion ({{te-limits}}).

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
Request languages can permit predicates over protected columns. An allowed
request can then answer questions about a masked value. The value itself
is never disclosed. A result-count of one versus zero is one bit. The
evidence for such a Disclosure is still accurate. The value was
transformed in the result. The client may still have learned something.

Consumers MUST NOT present Transformation Evidence as proof of
non-exposure. Nor is it proof that the transformation was applied: the
payload is a signed assertion by the Issuer that it was. A Verifier may
check the disclosed bytes against that assertion. Until then, the
evidence is what the pinned Issuer asserted. Where the Issuer is the
Gateway that performed the transformation, the assertion is self-attested.
A Consumer who treats it as verified has dropped the Issuer from the
trust statement. Nothing replaces that Issuer. A deployment that needs a
class to be unlearnable must enforce that in policy. It can refuse the
objects that carry the class. No evidence structure substitutes for that.

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
disappear from an account it does not produce. Where those components
share one operator, that separation is administrative. The same-operator
limit is in {{security}}.

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
clean report. Why a reset fails the Window, rather than dropping the
reset patterns, is a same-operator concern ({{security}}).

Window membership is itself a bound. It is decided across two clocks. The
snapshot timestamps are taken by the Data Source. A Receipt's timestamp is
written by the Gateway. An exact comparison between them fails in one
direction. A Gateway clock that trails the Data Source moves a Receipt
out of the Window. The object that Receipt names then looks like activity
with no Receipt. That outcome is the one whose semantics name gateway
bypass ({{cr-semantics}}). A clock difference of seconds can produce the
accusation. No real gap is required. The measured case was three seconds
({{implementation-status}}). The procedure sets no floor. A smaller
offset is harder for a reader to suspect. The Mapping Profile states the
skew bound ({{cr-mapping}}).

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
Receipts — and neither population is assumed complete. Each Item in either
population receives exactly one of the following outcomes. The result
statement names these outcomes as fields ({{cr-result}}):

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

One Client-level operation may produce several Source-level statements. The
multiplicity is not a property of the Gateway. It is a property of the
deployment. A pooler or an object-relational mapper can produce it. A
Gateway cannot measure a correspondence it does not produce.

A Mapping Profile is therefore declared by the operator. For each
Client-level operation it covers, it states the expected source-level
patterns. It states the multiplicity bound. It states the exclusion rules
({{cr-exclusions}}). It carries a version identifier. It is serialized
and digested as in {{digests}}.

The profile also declares the temporal correspondence. The operator knows
it. The Gateway cannot measure it. It names the clock on each side. The
Data Source stamps snapshots. The Gateway stamps Receipts. It states the
skew bound between them. Both are operator statements. A claim that both
sides read one clock, so the bound is zero, is still a declaration. One
clock read twice is not read at the same instant. Whether the residue
matters is a judgement about the deployment. The rule below forbids
presenting that as measured. This document also refuses a third case:
zero because nobody looked, declared by nobody, and read as agreement.

The temporal correspondence is declared in three fields under a `clocks`
member. The encoding is given so another specification can adopt the same
shape:

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
these three, and SHOULD name the key it rejected. A silently ignored fourth
field declares less than its author believes. The gap shows up as an
outcome the operator cannot account for.

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

The consequence is a ceiling. A coverage outcome against a declared
correspondence cannot be stronger than the declaration. Where the
declaration is an operator statement, the outcome inherits that standing.
The result statement must show it. The same discipline applies to absent
evidence in {{cr-semantics}}. A declaration presented as a measurement is
an overclaim. Truth of the declaration does not change that.

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
Window are `indeterminate` and the result reports the offset. The reader
compares that offset with clocks the reader knows. The Reconciler does
not.

An implementation MAY, absent a declared bound, decline to offer the boundary
as the explanation for an offset larger than the Window itself, on the ground
that a boundary artefact cannot exceed the interval it bounds. This is a
reporting choice about what an implementation is willing to suggest, not a
change of outcome: the item is `indeterminate` either way. The
twenty-three hour case that motivated this choice is in
{{implementation-status}}.

## Exclusions {#cr-exclusions}

Exclusion differs from the other outcomes in kind. `matched`,
`observed-without-receipt`, `receipted-without-observation`, and
`indeterminate` are produced by the comparison. `excluded` is a decision
taken before it. It decides what will be compared at all. A reconciliation
can be made to come out clean through this outcome. It therefore needs
the tightest reporting rules of the five.

Exclusion rules MUST be stated in the Mapping Profile and are therefore
covered by its digest. A result statement MUST report the count of excluded
items and the rule that excluded each of them. An implementation MUST NOT
exclude items by a rule that is not in the profile.

Without these constraints a clean result and a result cleaned by
exclusion look the same. The digest that pins what was compared then
misses the step that decided what was compared. Session or catalog
housekeeping is a legitimate exclusion. Exclusions need not be rare.
They must be visible and pinned.

Pinning is easy to read as more than it is. The rule identifier makes the
exclusion reproducible. A reader sees which rule removed each Item. The
reader can check that the rule was in the profile the digest covers. That
does not establish that the exclusion was correct. A housekeeping rule
and a rule that hides the auditor's target pin the same way. They verify
the same way. The mechanism reproduces the decision. It does not judge
it.
Consumers MUST NOT read a pinned exclusion as a justified one, and a result
statement MUST NOT present the digest as evidence that the exclusions were
appropriate. The same distinction holds between a declared bound and a
measured one ({{cr-mapping}}). Here it applies to what is compared at
all.

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
: A result carries `matched` as a count while carrying every other outcome as
  an accounting, and the asymmetry is deliberate. A count a reader cannot
  reconstruct is an assertion about a population the producer alone can see.
  This one is not that: the result digests both activity snapshots and the
  receipt set it compared ({{cr-snapshots}}, {{digests}}), and a reader holding
  those inputs recomputes the matched set. The size is not an assertion.
  The count is a convenience over material the reader already has.
: That property fails in one named case. The identifying material for the
  receipt set may be read from the receipt set itself
  ({{sec-completeness}}). A reader then recomputes the Issuer's answer.
  The digest checks transcription, not completeness. The `matched` count
  inherits that standing.

The result statement is serialized and digested as in {{digests}} and is
intended to be signed by the reconciling party and registered
({{scitt}}). The reconciler SHOULD be operationally independent of the
Gateway; where it is not, registration on a Transparency Service at
least makes the result's existence and timing third-party-visible.

## Semantics of the outcomes {#cr-semantics}

An `observed-without-receipt` outcome states that evidence is absent. It
does not state why. Gateway bypass produces it. Receipt sink failure
produces it. Accounting scope mismatch produces it. A Receipt that names
the object but falls outside the Window on the two clocks also produced
it. {{cr-procedure}} therefore removes that case from this outcome. An
earlier revision listed the mirror condition under
`receipted-without-observation` only. This text names both directions so
the omission is visible. A result statement MUST NOT
label such activity as an intrusion, a breach, or an intentional act, and
consumers MUST NOT present it as such. The mechanism surfaces the
condition. Cause is investigation, not reconciliation.

A `receipted-without-observation` outcome is likewise a statement about
evidence. It is not by itself a fault. A counter reset at the Window
boundary produces the same shape. So does an intermediary that collapses
statements. So does an increment outside the snapshot pair. A receipt
that describes activity that did not occur produces it too. An implementation MAY treat it as a
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
sense of {{RFC9943}}. The Issuer signs the serialized structure. For
Transformation Evidence that Issuer is the Gateway operator. For a
Coverage Reconciliation result that Issuer is the Reconciler. The Issuer
registers the Signed Statement on a Transparency Service. The SCITT
Receipt is proof of inclusion, at a position, in an append-only log. That
log is operated by a party other than the Issuer.

This layering is deliberate. The structures gain their audit value from
registration the Issuer cannot quietly rewrite. SCITT already defines
that place, its trust model, and its verification. This document defines
no countersignature, no anchoring, and no log format of its own. Digests
in this document bind evidence to receipts over the payload. The binding
survives registration. It is not over the envelope.

# Security Considerations {#security}

Same-operator collusion.
: In many deployments the Gateway and the Data Source are operated by the
  same party. Value against that party is reduced. An operator with
  administrative access to the source accounting can suppress the
  counters. The invalid-window rule ({{cr-procedure}}) turns a reset
  into a visible failure. Registration ({{scitt}}) makes suppression of
  already-issued results detectable. An operator who controls both
  accounts and never registers is outside this mechanism. Assurance
  against that operator needs an accounting path the operator cannot
  write to. That is a deployment property, not a payload property.

Counter manipulation.
: An attacker who can reset or rewind source counters could otherwise
  hide activity between snapshots. The MUST-fail rule exists for this
  case: a Window containing a regression is reported unreliable in its
  entirety. Snapshot frequency bounds the exposure — shorter Windows
  mean a reset costs the attacker a visible failure sooner.

Declared correspondence as an attack surface.
: The Mapping Profile ({{cr-mapping}}) is written by the operator. It
  decides what counts as a match. It decides what is excluded before
  matching. A wider multiplicity bound can absorb unreceipted activity.
  An added exclusion rule can remove it from comparison. This mechanism
  does not defend against that operator. Nothing computed against a
  declaration can. It makes the declaration part of the evidence. The
  profile is versioned. Its digest is bound into the result. Exclusions
  are reported with count and rule. The result states that its bounds are
  operator-declared. A reader who trusts the result sees that dependency.
  Registration ({{scitt}}) makes the sequence of declared profiles
  third-party-visible. A silently edited profile would lose that.

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
consistent. Every remaining link verifies. Every signature checks. The
file does not state how many entries it should have contained.
Reconciliation does not close this. It compares the receipt set against
source accounting. An operator who can truncate one can generally
suppress the other. Detecting the removal needs a count, a head digest,
or an equivalent quantity. That quantity must not come from the
truncated file.

What matters to a Consumer is where that material arrives from. The two
constructions differ in a way a digest does not reveal.

An implementation may accept the expected quantity as a verifier input.
The check is then only as trustworthy as that input. An auditor who holds
only the receipt file has no source for it except the Issuer. That is
the party under examination. The verification is real. Its independence
is supplied by whoever ran it. It is not a property of the artifacts.

An implementation may instead carry the quantity inside the signed
material. The set then testifies to its own extent. That closes the first
gap. The cost should be stated. The Issuer is signing an assertion about
a population it has not finished producing. A per-entry counter
constrains only the entries that were kept. A sealed total is also
required. A running count derived from the sequence number it accompanies
adds no information. It restates the position of a present record. It
says nothing about an absent one. The useful property is a sealed
quantity over a held set. It is not a per-record decoration.

This document requires neither construction. It requires that a result
identifying a receipt set be readable as to which one it used. A Consumer
who cannot tell them apart will read an external pin as if the receipt
set had proved its own completeness. That is the strongest claim in this
area. It is the one least often actually made.

# Privacy Considerations

Every structure in this document follows one rule. Evidence about
protected data must not itself become a disclosure channel.
Transformation Evidence carries class names, action names, and counts.
It never carries values. Request and pattern references are digests.
Query and pattern text can embed values and schema detail. Class names
and counts do reveal that a class was present, and in what quantity.
Deployments that treat even that as sensitive can keep the payloads
private. They can register only the digests. Third-party audit then
becomes a permissioned act.

# IANA Considerations

This document requests registration of two media types and the creation
of two registries. Registrations follow {{RFC6838}}. Registry policy is
Specification Required as defined in {{RFC8126}}.

## Media type: application/transformation-evidence+json

Type name:
: application

Subtype name:
: transformation-evidence+json

Required parameters:
: None.

Optional parameters:
: None.

Encoding considerations:
: 8bit; binary UTF-8 JSON. For digesting and signing, the payload is
  serialized with {{RFC8785}}.

Security considerations:
: See {{security}} and {{te-limits}}. The payload MUST NOT carry data
  values.

Interoperability considerations:
: Implementations that do not recognize the `v` member MUST reject the
  object.

Published specification:
: This document, {{te-structure}}.

Applications that use this media type:
: Policy gateways and auditors that record or verify a disclosure
  transformation.

Fragment identifier considerations:
: None.

Additional information:
: Deprecated alias names for this type: none. Magic number(s): none.
  File extension(s): none. Macintosh file type code(s): none.

Person and email address to contact for further information:
: See the Authors' Addresses section of this document.

Intended usage:
: COMMON

Restrictions on usage:
: None.

Author:
: See the Authors' Addresses section of this document.

Change controller:
: IETF

## Media type: application/coverage-reconciliation+json

Type name:
: application

Subtype name:
: coverage-reconciliation+json

Required parameters:
: None.

Optional parameters:
: None.

Encoding considerations:
: 8bit; binary UTF-8 JSON. For digesting and signing, the payload is
  serialized with {{RFC8785}}.

Security considerations:
: See {{security}} and {{cr-semantics}}.

Interoperability considerations:
: A consumer MUST NOT read a `coverage-reconciliation/1` result as a
  `/2` result ({{cr-result}}).

Published specification:
: This document, {{cr-result}}.

Applications that use this media type:
: Reconcilers and auditors that compare source activity with a receipt
  set.

Fragment identifier considerations:
: None.

Additional information:
: Deprecated alias names for this type: none. Magic number(s): none.
  File extension(s): none. Macintosh file type code(s): none.

Person and email address to contact for further information:
: See the Authors' Addresses section of this document.

Intended usage:
: COMMON

Restrictions on usage:
: None.

Author:
: See the Authors' Addresses section of this document.

Change controller:
: IETF

## Transformation Actions registry

IANA is asked to create a new registry titled "Transformation Actions"
in a new "Disclosure Evidence" group.

Registration policy:
: Specification Required ({{RFC8126}}).

Registration template:
: Action name (unique ASCII token); description; reference.

Initial contents:

| Action name | Description | Reference |
| mask | Replace a value with a class-level placeholder | This document, {{te-structure}} |
| redact | Remove a value | This document, {{te-structure}} |
| tokenize | Replace a value with a stable token | This document, {{te-structure}} |
| truncate | Shorten a value | This document, {{te-structure}} |
| none | The class occurred and was disclosed untransformed | This document, {{te-structure}} |

## Coverage Reconciliation Outcomes registry

IANA is asked to create a new registry titled "Coverage Reconciliation
Outcomes" in the same "Disclosure Evidence" group.

Registration policy:
: Specification Required ({{RFC8126}}).

Registration template:
: Outcome name (unique ASCII token); description; reference.

Initial contents:

| Outcome name | Description | Reference |
| matched | The Item corresponds to an Item in the other population within the declared bounds | This document, {{cr-procedure}} |
| observed-without-receipt | The Data Source recorded activity against a Data Object that no Receipt in the Window names | This document, {{cr-procedure}} |
| receipted-without-observation | A Receipt in the Window names a Data Object for which the Data Source recorded no activity | This document, {{cr-procedure}} |
| excluded | The Item was removed from comparison by a Mapping Profile rule | This document, {{cr-exclusions}} |
| indeterminate | The evidence or the Mapping Profile does not determine an outcome | This document, {{cr-procedure}} |
| invalid-window | The Window is unreliable (counter regression or snapshot mismatch) | This document, {{cr-result}} |

# Implementation Status {#implementation-status}

*This section is to be removed before publication as an RFC, per
{{RFC7942}}.*

One implementation of both mechanisms exists: the Conarium gateway
(TypeScript, MIT license, `@conarium-ai/core` on npm). It has run at one
site since July 2026. Its receipts carry per-class masking counts as in
{{transformation-evidence}}. Its `conarium-reconcile` tool implements
{{cr-procedure}} against PostgreSQL statement statistics. The tool is a
single file. It has no dependency on the package. A third party can run
it without trusting the implementation under audit. Conformance test
vectors ship with the package.

The state below was measured against the published 0.2.38 package. It was
not read from the package documentation. It is now checked, not measured
once. Every revision of this section up to -04 described a tool that had
moved past it. Each time it claimed less than the code did. The
correction is at the end of this section. The failure is more instructive
than the current state.

As of 0.2.38 the tool emits the result statement of {{cr-result}} as
`coverage-reconciliation/2`, on a flag of its own. The `/1` body is unchanged
and still carries `conarium-reconcile/0.1`. The `/2` result carries
`profile`, `bounds`, `outcome`, `items`, and `counts` under the names used
here. It reads Mapping Profiles ({{cr-mapping}}), including the three
`clocks` fields.

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

One gap remains. The tool's exit codes predate this vocabulary. They are
not a mapping of it. They were left unchanged on purpose. An exit code is
a compatibility contract. Renumbering them to match this document would
break installations. That would make a specification look implemented.
One code was added rather than renumbered. It is for the temporal
outcome. Existing callers do not notice it.

The gap that produced this section's own history is closed. The -04
revision carried four statements. They were accurate when written. They
were false within days. Each claimed less than the code did. No mechanism
here found them. A reader holding the document beside the tool's output
did. The -05 revision recorded that the test suite had no check against
this section. Until such a check existed, it said, read the section as a
claim about the date it was measured.

A check now runs this section instead of reading it. Every behavioural
statement above is bound to a run of the shipped tool. The fixture is
named in this document. Two directions are enforced. Every value a run
produced must appear in the sentence that states it. The number of
statements must equal the number of bound runs. A statement with no run
is unmeasured. A run with no statement is a dropped measurement. The
revision under test is derived from the repository. It is not named in
the check. A hard-coded revision is the same class of stale declaration
the check exists to catch.

The first thing it caught was the sentence in the paragraph above. From
the commit that added the check, -05's account of its own absence was
false. A posted draft cannot be edited. This revision is where the
correction has to live. A check whose first finding is the sentence
claiming it does not exist has shown the failure mode it was written for.

Two limits, stated rather than left to be found. The check pins the
behaviour statements. It does not pin the prose around them. A paragraph
can still go stale in a way nothing runs. A failure has two honest
resolutions. Change the code back. Or write the revision that says what
the code now does. Editing a posted draft is not one of them. The cost of
drift is then a document, not a diff.

A second check covers the conformance class rather than this document.
Every outcome the result statement can carry has a case that produces it.
Each independent ground for `indeterminate` has a case of its own. The
list of outcomes is read from the tool's own result. It is not restated
in the check. An outcome added to the vocabulary arrives there without a
reminder. It arrives failing until some case produces it. A conformance
class can lose coverage in silence. Nothing in a test set records what
was removed from it. A class that has lost coverage still passes.

Earlier revisions of this document, and releases of that implementation
up to 0.2.21, described a clean reconciliation as "covered". That word
asserted more than the procedure establishes. It was corrected in the
implementation in 0.2.22 and in this document in -03.

The temporal rule added in -04 has the same history, compressed. The
implementation admitted Receipts on an exact comparison across the two
clocks. A Receipt three seconds outside a two-hour Window produced
`observed-without-receipt` and a bypass message. That was raised in
review of -03 on the SCITT mailing list. It was reproduced. It was
corrected in 0.2.27. The correction was then attacked. A Receipt from the
previous day named the same object. It moved a real in-Window absence
into the new outcome. The implementation offered the boundary as its
explanation. A twenty-three hour offset cannot support that. 0.2.28
bounds what the implementation is willing to suggest. That is the
reporting choice in {{cr-mapping}}. Both defects were in the
implementation first. Neither was found by reading this document. The
first came from review of -03 on the list. The second came from an
adversarial review of the implementation. The fix had loosened a default.
Its author was not the party who should clear it. What made the second
sentence sayable was the tool's own output. This text did not yet exist.
The document's part was smaller and later. It is where the correction has
to be written down. The next implementation should not have to be
attacked to learn it.

--- back

# Acknowledgments
{:numbered="false"}

The discipline of stating what each structure does not prove is owed to
every auditor who has been handed a green dashboard and asked to trust
it.

Iman Schrock reviewed revision -02 on the SCITT mailing list. He identified
two overclaims. One was that a clean reconciliation established coverage of
the source activity. The other was that Transformation Evidence proved the
transformation rather than the Issuer's assertion of it. Both were
corrected in -03. The outcome vocabulary of {{cr-procedure}} follows from
that exchange. So does the rule that a declared bound cannot yield a
stronger outcome. Reviewing -03, the same reviewer established a further
point. An Item whose classification rule does not resolve under the pinned
profile is `indeterminate`, not excluded. Revision -04 applies that rule
one layer up, to bounds.

Walter Hawkins read the reconciliation implementation. He found the
temporal defect -04 exists to correct. Window membership is decided
across two clocks. An exact comparison manufactures an accusation where
no gap exists. The failure is asymmetric. It produces false findings
rather than missed ones. He also observed that the sub-second case is
the dangerous one. It is the one a reader will believe. That is why
{{cr-procedure}} sets no floor. The requirement that a source population
declare its own completeness on the same standing ladder is also his.

Joel Hillier, reviewing -04 on the SCITT mailing list, asked for named
fields. He wanted a stated encoding for the temporal correspondence, not
prose. Another specification could then adopt the same shape. The three
`clocks` fields in {{cr-mapping}} are written to be copied. They answer
that request. He also observed that a gaps section going stale in the
understating direction is the same failure as one that overstates. That
is why the Implementation Status section of this revision was rewritten
from measurement.

Henri Sirkkavaara established the distinction in {{sec-completeness}}.
One construction supplies an expected quantity to a verifier from
outside. The other carries it inside the signed material. He built the
second. He named what the first leaves an auditor unable to do. The
consequence is stated against this document's own implementation, which
does the first. A running count derived from the sequence number it
accompanies adds no information. That narrower observation is this
author's, arrived at while measuring his. It is recorded here because it
bears on the construction. The distinction stands.

Andrew Yourtchenko reviewed -04 as a reader new to the work and identified
the length and density of the non-normative prose as the document's
primary obstacle, ahead of any technical point. He proposed applying the
principles of ASD-STE100 (Simplified Technical English) to the
non-normative text and published a rule set and a rewritten draft to show
the effect. The sentence-length pass in -07 follows that suggestion.
