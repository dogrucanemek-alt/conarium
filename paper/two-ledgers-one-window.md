# Two ledgers, one window: integrity of a mediator's record does not establish its completeness

Emek Can Doğru  
VERAX TEKNOLOJİ LİMİTED ŞİRKETİ, Izmir, Turkey  


## Abstract

Integrity marks on a mediator's record show that the rows still present were not altered, reordered, or removed from the middle after they were written. They do not show that every event that happened was written. This paper states that distinction as one conditional impossibility result (Proposition 1) and two normative principles (Principles 2a and 2b). Proposition 1 (Single-Ledger Insufficiency): under seven stated assumptions, a bypass path yields two worlds that differ in whether an occurrence happened and share the same record \(R\); no judgement whose only input is \(R\) can distinguish them. Principle 2a (Provenance Ceiling) forbids labelling a bound's standing above the origin of the input it rests on. Principle 2b (Undeclared Does Not Decide) leaves items whose required bound is undeclared indeterminate. The method compares a source activity book against a mediator record over one window on two clocks, and assigns every remaining item to one of five outcome classes. A worked example of four desk rows and six source rows (measured) shows how a second book can decide a miss relative to that book, and how two clocks can take that decision away. Implementing artefacts are listed at the end.

## 1. Introduction

A mediator \(G\) writes a record \(R\) of the events it sees. Integrity marks on \(R\) — a sequence \(G\) assigned, a hash \(G\) chained, a signature \(G\) produced — show that the rows still in \(R\) were not altered, reordered, or removed from the middle after they were written. They do not show that every event that happened was written.

That is not a software defect. If there is any path by which an event can occur without \(G\) seeing it, there are two worlds in which \(R\) is the same: one where the event did not happen, and one where it happened unobserved. No function of \(R\) alone tells those worlds apart. Completeness of \(R\) with respect to what occurred is independent of the integrity of \(R\). A second account, under different custody, is what makes the missing row visible. If that second account is also short, the honest answer is not a pass. It is that the comparison did not decide.

That is the single-ledger blindness proposition: a bypass path plus a record that does not depend on the bypassed event yields two worlds that share \(R\). It is a conditional impossibility result under seven explicit assumptions, not an unconditional completeness theorem. If the unobserved event changes later rows \(G\) does write — a source sequence copied into \(R\) — then \(R\) has already imported a second account, and this setup is not blind.

The rest of the paper states the assumptions that carry that proposition, two normative principles that cap how a result may label the standing of its bounds, a four-step comparison that uses two books and one window, a classroom example that breaks the usual wrong answers in order, and the cases the method does not catch. The last sentence of this introduction is the standing of the whole: it is a conditional impossibility result under seven explicit assumptions, not an unconditional completeness theorem.

## 2. Setting and assumptions

Let \(G\) be a mediator producing record \(R\) of events it observes, and let \(E\) be the multiset of occurrences that actually happened. The propositions below rest on seven assumptions. Each is required for the two-world construction; dropping one changes what the construction may say.

**A1.** \(R\) is a subset of \(G\)'s observations. A mediator may write selectively — sampling, or omitting a refused request — so the record need not contain every observation \(G\) made.

**A2.** A bypass path does not write a row into \(R\) and does not alter rows already there. If the bypass updated \(R\), the two worlds would not share \(R\).

**A3.** The auditor holds only \(R\). Distinguishing information that lives only outside \(R\) is not available to a judgement whose only input is \(R\).

**A4.** The integrity mechanisms of \(R\) (signature, chain, sequence) are produced by \(G\). They speak about the set \(G\) wrote. They are silent about an occurrence \(G\) did not produce.

**A5.** An unobserved occurrence does not change the content of rows \(G\) writes afterwards. This is the load-bearing assumption. If a source issues a sequential identity (a Postgres transaction identifier, a write-ahead-log sequence number, a serial, a stock balance) and the unobserved occurrence advances it, then a later row \(G\) does write can differ between the two worlds — for example \(7\) in one world and \(8\) in the other (declared, illustrative). That difference sits inside \(R\). The construction is then not blind: the leaked source identity is a second account already embedded in the first book. Recording that identity on every mediated access is therefore a design opening. Whether typical mediated deployments break A5, and how far a reconciliation that uses those identities would reach, is not measured. The internal randomness and internal state \(G\) uses to produce signatures and the chain are fixed in both worlds; an unobserved occurrence does not affect them.

**A6.** \(E\) and \(R\) are bound to the same window. An occurrence outside the window is out of scope, not a blindness of the record.

**A7.** \(E\) is a multiplicity of identified occurrences, not a set of types. Two occurrences of the same statement pattern are two members of \(E\).

A5 is listed with the others because the construction fails without it, and because its failure is useful rather than fatal. The usefulness is a design remark. The frequency of the failure is not measured.

## 3. Proposition 1 — Single-Ledger Insufficiency

**Proposition 1 (Single-Ledger Insufficiency).**
Let \(G\) be a mediator producing record \(R\) of events it observes, and let \(E\) be the multiset of occurrences that actually happened. Under assumptions A1–A7 above, if there exists a path by which an occurrence can happen without \(G\) observing it, then **there exist two worlds \(W_0\), \(W_1\) differing in whether that occurrence happened, for which \(R\) is identical.** Consequently no judgement whose only input is \(R\) can distinguish them.

### Proof sketch

Fix a bypass path satisfying A2, and an occurrence \(e\) that can take that path. Construct \(W_0\) in which \(e\) does not occur inside the window (A6), and \(W_1\) in which \(e\) occurs unobserved. By A1, \(R\) contains only observations \(G\) made; \(e\) is not among them in either world. By A2, the bypass does not add or edit a row of \(R\). By A5, \(e\) does not change later rows \(G\) does write. By A4, the integrity marks \(G\) attaches are functions of the rows \(G\) wrote and of \(G\)'s internal randomness and state, both held equal across the two worlds, so they match when the rows match. By A3, the auditor sees only that \(R\). The two worlds differ in \(E\) (A7) and agree on \(R\). Therefore any procedure whose only input is \(R\) returns the same answer in both worlds.

The sketch does not generalise past A1–A7. It does not say that two books suffice: both can be short. It does not say that a bypass occurred: only that \(R\) cannot tell the two worlds apart. It does not say that a sequence number is useless: a sequence \(G\) assigned shows what was dropped from the set \(G\) produced, and is silent about what \(G\) did not produce.

## 4. Principle 2 — Provenance Ceiling (2a) and Undeclared Does Not Decide (2b)

**Principle 2a (Provenance Ceiling, per bound).**
Each bound (multiplicity, skew, exclusion, population) carries an origin class: `undeclared < operator-declared < measured < protocol-enforced`. A result MUST NOT label a bound's standing above the origin of the input it rests on.

**Principle 2b (Undeclared Does Not Decide).**
A bound whose origin is `undeclared` cannot license a decision that depends on it. The affected items are `indeterminate`.

The order is an origin order, not a strength order. A broken measurement is less useful than a careful declaration. It is not a truth ranking.

The structure is a product order, not a total order. The pair `(measured multiplicity, undeclared skew)` is incomparable with `(undeclared multiplicity, measured skew)` (declared, illustrative). Collapsing both pairs to a single meet would be a safe over-coarsening; it would also hide which bound is carrying the result.

Outcome classes (`attributed`, `indeterminate`, and the rest) and origin labels (`operator-declared`, `measured`) do not sit on one scale. Asking whether an attribution sits "above" an operator declaration is a type error. Two operator-declared books can still yield a measured account-claim: the count of differing rows is a computed relation. They cannot yield a measured world-claim: an inference from that count to unrecorded access in the world still rests on the declared bounds.

| Claim kind | Example (declared, illustrative) | Standing |
|---|---|---|
| Account-claim | "The two books differ by 3 rows" | measured — a computed relation |
| World-claim | "Therefore 3 accesses were not recorded" | no stronger than the bounds it rests on |

The ceiling applies to world-claims, not to account-claims. Principle 2b forces `indeterminate` as an outcome class when a required bound is undeclared. It does not force every item into that class. An operator-declared correspondence may still attribute. It may not print that attribution as a measurement.

## 5. Method — two ledgers, one window

Two accounts, two custodians. Postgres and a shell are enough.

**Account S** is the data source's own activity book. In Postgres this is a pair of `pg_stat_statements` snapshots for one dedicated role, at the start and end of a window. The source writes these counters. The mediator does not. If one party can rewrite both books and does not publish a result, the method cannot see the suppression.

Each snapshot is a timestamp (the source's clock) plus, for every statement pattern the source distinguishes, a cumulative count. The window is the difference: patterns whose count rose, and by how much. If any count falls, or a pattern vanishes, the source's book was reset or evicted inside the window. The window is then unreliable. The method stops. It does not reconcile the surviving patterns and call the rest noise.

**Account G** is the mediator's record: which objects it named, at which time (its own clock). Integrity of that file is checked first, by the file format's own rules, and is out of scope here.

Custody is different by construction: S is produced by the source, G by the mediator. A bypassed query increments S and does not appear in G. That is the only reason the comparison can notice it. A shared database role across clients blames the mediator for other people's queries.

Four steps. Skipping one must not silently upgrade the result.

**Window.** Take S at \(t_0\) and \(t_1\), both stamped by the source. Collect from G the rows whose timestamps the mediator wrote. Membership in the window is already a bound, and it is decided across two clocks. Comparing those timestamps as if they were one clock makes the failure asymmetric: a mediator clock that trails the source moves a genuine G-row out of the window, and the object it would have accounted for becomes "source activity with no mediator row". That sentence is the bypass sentence. Seconds of skew manufacture it.

**Correspondence.** An operator declares how one client-level operation maps onto source-level statements: which patterns, a bound on their multiplicity, which clock each side uses, and a bound on the skew between those clocks. The mediator cannot measure a correspondence it does not produce. A connection pooler or an object-relational mapper is a property of the deployment. The declaration is therefore an operator statement, not a measurement. Write it down. Digest it. Bind the result to that digest. If a required bound is undeclared, do not substitute one. A default of one-to-one invents false gaps on any deployment with a pooler. A default of zero skew invents the accusation the two-clock problem exists to prevent.

**Exclusion.** Some source activity is not in scope: session setup, catalog reads, a monitoring user. Exclusion is a decision taken before comparison, about what will be compared at all. It is the step through which a result can be made to come out empty of exceptions, and it is the step that must be the most visible. State every rule in the same declaration that carries the multiplicity and the skew. Report the count and the rule. A pinned exclusion is reproducible. It is not therefore correct. A rule that drops housekeeping and a rule that drops the statements the auditor came to see verify the same way.

**Classification.** Every remaining item in either population gets exactly one outcome. Matching is per pattern and per object, not per call count. One client request may legitimately produce several source statements. One mediator row that names an object clears an unbounded number of further statements against that object inside the window. The procedure has then established object attribution, and nothing stronger. A pattern whose target objects cannot be determined is not ignored. It is left undecided.

Example (declared, illustrative): S at 10:00 and 10:10 for role `app`. `patients` rose by 3, `labs` by 1, `pg_catalog` rose and is excluded by a named rule. G has two in-window rows naming `patients` and none naming `labs`. Under a declared one-to-many bound, `patients` is attributed. `labs` is not.

### Five outcome classes

Each class is a statement about the comparison. None is a statement about intent.

**Attributed (matched).** The item corresponds to an item in the other population, inside the window, inside the declared bounds. The two kinds of bound do not act alike. A multiplicity bound admits items to this class. A skew bound does not: a mediator row outside the window is not attributed, however small the declared skew. The bound says how far the boundary can be trusted, not where the boundary is. This class does not mean every source statement was itself recorded by the mediator. It does not mean the populations have no gaps. It does not mean the correspondence was measured.

**Observed without a mediator row.** The source recorded activity against an object that no in-window mediator row names. This means evidence is absent. It does not mean bypass. It does not mean the mediator's sink failed. It does not mean a scope mismatch. All three produce the same shape. Investigation attributes cause; this method does not. If the only naming row in G sits outside the window, this class is the wrong one — that case is undecided, below.

**Recorded without a source observation.** A mediator row in the window names an object for which the source counters did not rise. This is also a statement about evidence, not a fault. A counter that increments outside the snapshot pair, a pooler that collapses statements, and a row that describes activity that did not occur have the same shape. A local policy may treat it as failure. The method does not define it as one.

**Excluded.** Removed before matching by a rule in the declaration. Not produced by the comparison. Report the rule. Do not read the digest of the declaration as a judgement that the rule was the right one.

**Undecided (`indeterminate`).** The evidence or the declaration does not determine an outcome. The pattern's objects could not be attributed; a required multiplicity or skew bound is undeclared; the item's only naming mediator row falls outside the window; or the window's evidence is insufficient to decide. This is a result. It is not a weaker pass. It is not "probably attributed". It is not "probably a gap".

A comparison with no "observed without a mediator row" items establishes that each observed source item is attributable to a mediator row naming the same object, under the declared correspondence. It does not establish that the source's book has no gaps, or that the mediator's file has no gaps, or that nothing happened off both books.

### Why undecided is mandatory, and why "clean" is forbidden

Two facts force the fifth class.

The first is the single-ledger fact already stated: one book cannot testify to what it did not write. Adding a second book does not close the world. Both can be short. A result that has only attributed and excluded items is named, in the published procedure, as "no exceptions under the declared correspondence". That name says what the comparison left open, not what it proved. Folding the leftover into "clean" asserts completeness of both populations. The method does not have that.

The second is the standing of the declaration. A result computed against an operator statement cannot present that statement as a measurement. Where a required bound is undeclared, the comparison does not get to pick a number. The affected items are undecided. Substituting a default decides the operator's question with a value the operator did not see.

A third, operational, reason sits on the window. When every object an item leaves unaccounted for is named by a mediator row that the two clocks put outside the window, the method cannot tell a trailing mediator clock from a late row. Reporting "observed without a mediator row" asserts a distinction it did not make. The item is undecided, and the offset is reported. An item that leaves even one object named by no mediator row anywhere is not rescued by a neighbour's clock. That is a genuine absence of a naming row, and it stays in that class.

What is forbidden is resolving the undecided class by assumption in either direction: counting it as attributed because nothing contradicts it, or reporting it as missing activity because nothing confirms it. Averaging it into a coverage proportion performs the same collapse and is forbidden for the same reason. The absence of a decision is not a decision.

The same discipline applies one layer up to labels. A bound is undeclared, operator-declared, measured, or protocol-enforced. The result states which. It does not print an operator-declared skew as measured. An operator-declared correspondence may still attribute. It may not call the attribution a measurement. That is a ceiling on labels, not a demand that every outcome be undecided.

## 6. Worked example — one book, two books, two clocks

The example is a clinic front desk and the clinic's own activity book. Times are naive local timestamps; each is read on the clock named in its column. The source window is `2026-08-20 10:00:00` through `2026-08-20 10:10:00` (declared), start-inclusive and end-exclusive. An item is in the window on the desk side only if the desk timestamp falls in that same civil interval.

Declared correspondence (declared): the match key is the object name; one desk row naming an object accounts for every source row on that object inside the window; the skew bound is undeclared unless a later question declares one; exclude `object = catalog` before comparing, and drop nothing else.

The published tables contain four desk rows and six source rows (measured); the exercise text's "twelve rows" counts the two header lines.

| desk_id | object | ts_desk |
|---|---|---|
| d1 | patients | 2026-08-20 10:01:00 |
| d2 | patients | 2026-08-20 10:03:00 |
| d3 | labs | 2026-08-20 10:04:28 |
| d4 | invoices | 2026-08-20 10:06:00 |

| stmt_id | object | ts_source |
|---|---|---|
| s1 | patients | 2026-08-20 10:01:02 |
| s2 | patients | 2026-08-20 10:03:01 |
| s3 | labs | 2026-08-20 10:04:30 |
| s4 | invoices | 2026-08-20 10:06:02 |
| s5 | catalog | 2026-08-20 10:08:00 |
| s6 | vitals | 2026-08-20 10:09:10 |

**Step 1 — only the desk.** Given the desk file and the window, and not the source file: whether a read of `vitals` went unlogged, and whether the desk rows are the full set of clinic activity, both answer *cannot tell*. Absence from one book is not absence from the world. A contiguous desk sequence is silent about a row the desk did not create. The wrong answers this step is built to collect treat missing-from-desk as a miss, or treat an intact-looking file as a full set.

**Step 2 — the second book.** Same window, same correspondence, skew still undeclared. Classification of source objects that are not excluded, as reproduced by `classify.mjs` (measured: 43 lines) and pinned by the published answer key:

| object | class |
|---|---|
| patients | attributed |
| labs | attributed |
| invoices | attributed |
| catalog | excluded |
| vitals | observed-without-receipt |

The exercise text names the absence class `observed-without-desk`. The published classifier and answer key emit `observed-without-receipt` for the same object. `vitals` is source activity with no desk row anywhere in the file, so the absence class is the right one, not `indeterminate`. Completeness of the desk with respect to this source book is now decidable for `vitals`. Completeness of either book with respect to the world is not: nothing in either file speaks to a third path (a replica, a backup, a role these counters do not see). Two books can both be short.

**Step 3 — the desk clock is wrong.** The desk clock was 6 minutes slow (declared). Every desk timestamp is rewritten six minutes earlier and is not corrected back. Skew remains undeclared. Window membership then puts `d4` at `10:00:00` inside the window and `d1`–`d3` outside it.

| object | class |
|---|---|
| patients | indeterminate |
| labs | indeterminate |
| invoices | attributed |
| vitals | observed-without-receipt |

Excluded rows are unchanged by the clock shift; `catalog` stays excluded.

`patients` and `labs` have naming desk rows, but those rows now sit outside the window. Attributed requires an in-window desk row. The method cannot tell a trailing desk clock from a late row, so those items are `indeterminate`, not observed-without-receipt. `vitals` still has no naming desk row anywhere; a neighbour's clock does not make a genuine absence undecidable. Folding this window into "clean" both promotes `indeterminate` to a pass and washes `vitals` out of the summary. The honest summary is one observed-without-receipt (`vitals`), two indeterminate (`patients`, `labs`), one attributed (`invoices`), skew undeclared.

A later declared skew bound of 7 minutes (declared, illustrative) still does not attribute a desk row that sits outside the window. The bound says how far the boundary can be trusted, not where the boundary is. A bound of 2 minutes (declared, illustrative) cannot explain a 6-minute offset as skew, and does not by itself turn the item into observed-without-receipt if a naming row exists outside the window.

**Extension — the second book is short too.** A reporting replica whose statements do not increment this source book can carry a read of `labs` inside the window. No class in the given files changes: the replica read is on neither side. Completeness was with respect to this source book. A path the book does not count is out of scope. The method does not upgrade a gap it cannot see into a finding, and it does not call the window clean because it cannot see it.

## 7. What the method does not catch

The method's own limit list, and the measured limits of a published reconciliation tool that implements the same comparison, are the same shape.

- **Same-party silence.** An operator who controls S and G and does not publish a result can suppress both books. Registration of an already-issued result with a third party makes later deletion visible. It does not create a result that was not written.
- **A falsified source book.** The method trusts the source's counters. An attacker who can increment, decrement, or reset them without a visible regression is outside it. A visible regression fails the window; a silent lie does not.
- **Events the source does not count.** A path that touches data without incrementing the book S is looking at — a replica, a different role, a filesystem copy, a backup restore — does not appear on either side.
- **Per-statement coverage.** Object attribution is weaker. One naming row clears the object for the window. A published reconciliation run that exits 0 (declared) when five source calls (declared, from the tool's positive case) sit under one naming receipt has established pattern and object overlap, not that each recorded statement was itself receipted.
- **Cause.** Absent evidence is not intent, not a breach, not a sink failure. The shape does not distinguish them.
- **Correct exclusions.** Reproducible is not justified.
- **Truth at write time.** Integrity of G is assumed already checked. Even then, rows can be intact and false.
- **Prevention.** Closing the bypass path is a different property. The method detects. It does not block.
- **Trailing clock versus late row.** The window comes from the source's snapshot timestamps and a mediator timestamp comes from the mediator, so the boundary is decided by two clocks. A naming row that would have covered a pattern but falls outside the window is `indeterminate` rather than observed-without-receipt, because the comparison has no way to know which of the two happened. An offset larger than the window cannot be a boundary artefact; a declared skew outranks the inference. Neither mode establishes that the naming row belongs to the access the counters recorded.
- **Recorded without a source observation.** The same shape appears when a counter was reset at the window edge, when a pooler collapses statements, or when the increment lands outside the snapshot pair. The category is visible. The method does not define it as failure.

The output is a classified comparison of two short books over a window that sits on two clocks. Absence becomes checkable. An undecided comparison is not rewritten as clean.

## 8. Relation to prior work

This section uses only a dated project scan of adjacent implementations and patents, plus two papers that scan named. It is a relation, not a priority claim.

Hash-chained, MAC-protected log entries are old public art. United States patent 7,770,032 B2, "Secure logging for irrefutable administration", is expired (declared: expired; source: the scan, confirmed on Google Patents as Expired — Lifetime). A contiguous, signature-valid chain says that what is held has not been altered. It cannot say that nothing is missing from what is held, because a mediator that was bypassed writes nothing and its chain stays intact.

Receiver-attested receipts invert the trust boundary: the service that receives a call signs what it observed. Figuera's *Notarized Agents / Sello* states the residual that remains after inclusion: an inclusion proof answers whether a receipt is in the log; it does not answer whether the log returned every matching receipt. The three remedies proposed there (declared) stay on the log side — a signed exhaustive answer from the log, downloading the whole log, or submitting to several independent logs. Sello v0.1 declines to speak for set completeness. Independently, Nian et al., *Auditable Agents*, name evidence integrity and lifecycle coverage among the most neglected dimensions of current audit approaches.

A scan dated 6 August 2026 (declared), amended 19 August 2026 (declared) after a related mechanism was raised on the SCITT mailing list, looked at project documentation for enforcement, portable signed receipts, and coverage reconciliation against the data source's own bookkeeping. Source-code-level search was not performed on any repository in the original pass. One row, Vaara, was later scored from source at commit `befdced` (declared): its design document specifies a join from each used credential to a receipt, and reads a used credential with no matching receipt as a bypassed broker, with the stated limit that this is detection of a defeated broker, not a mathematical-completeness claim. At that commit the scan found no collector, join, command, or test implementing the join. That is the only such design the scan found outside the artefacts of Section 9. Reconciling against the data source's own counters was not among the proposals found in the Sello paper or elsewhere in that scan.

Two near misses are worth naming because they use the same words for different objects. One governance toolkit publishes a "completeness score" that measures how many required fields it populated from signals it already collected, and a "reconciliation" of discovered agents against a registry. Neither asks whether the data source saw access the chain has no receipt for. A commercial agent monitor that tracks calls made outside a gateway through hooks in client tools sees what the client tells it. That is not the data source's own telemetry, and it comes with no signed receipt.

The Supply Chain Integrity, Transparency, and Trust architecture (RFC 9943) defines registration of signed statements on a transparency service. Receipt formats that sit on that architecture inherit the inclusion residual Sello names. An individual Internet-Draft, listed among the artefacts, defines evidence payloads for transformation evidence and coverage reconciliation intended for registration as signed statements on such a service. It does not define a new receipt format, a new transparency mechanism, or a new signature format.

Patent claim charts in the same scan (Microsoft access-logging, OneTrust consent receipts, Google verifiable consent) are about other objects — a three-party callback at the data server, consent collection shown to a data subject, or an input credential validated before an action. They are not reused here as a method claim. Searches for `pg_stat_statements` combined with audit reconciliation returned performance-tuning and database-audit material; no implementation reconciling those counters against a receipt or audit chain was found. Two searches returned topically unrelated accounting "proof of cash" and payment-reconciliation results rather than nothing; that is a fact about the index, not evidence that nothing exists. One essay whose title touches the integrity-versus-coverage distinction returned HTTP 403 (declared, from the scan) and was not read.

None of enforcement, signed receipts, or query counters is an invention. The combination the scan could not find implemented — masking or mediation before disclosure, a portable receipt of that act, and a comparison against the source's own book — is the unusual part, in the same sense that a software-bill-of-materials format did not invent dependency lists. The scan will not support "the only one in existence". The honest form is the dated search record.

## 9. Artefacts

The following artefacts implement or specify the method. The product name appears only in this section.

- npm package `@conarium-ai/core`, version `0.2.46` (declared: the release this preprint describes and the snapshot below covers; the repository at the commit that carries this preprint names a later number).
- Individual Internet-Draft `draft-dogru-scitt-disclosure-evidence-07`, title *Transformation Evidence and Coverage Reconciliation for Auditable Data Disclosure* (declared, from the draft front matter; posted 23 August 2026). It defines Transformation Evidence and Coverage Reconciliation as evidence payloads for registration as signed statements on a transparency service as described in RFC 9943.
- Conformance vectors shipped with the package: thirteen receipt cases, one public key, one manifest (declared); eight JCS argument preimages for `hashArgs()` (declared); six official RFC 8785 input/expected pairs, compared byte for byte (declared); and 3,000 published IEEE-754 doubles sampled from the reference set of 100,000,000 (sampled, \(N = 3000\) of \(M = 100000000\)).
- Software Heritage snapshot `swh:1:snp:d60322ed2ea0b1cd4a3e75847677e9a04e18b65a` (measured: save request 2449665, visit 2026-08-22T20:36:29Z, resolved through the archive's API; `refs/heads/main` at `3c7536c`, release tags through `v0.2.46`). The snapshot covers the release this preprint describes; the commit carrying the preprint itself is later than the snapshot and is archived by the repository's next save.
- A Go verifier lives in the same repository, under the same maintenance, at `verifiers/go/` (declared). It is a second implementation of the receipt checks, not an independently governed project.

## 10. Conclusion

A record can be intact and still silent about what was not written. Under the seven assumptions of Proposition 1, a bypass path produces two worlds that share \(R\). Integrity marks do not close that gap. A second book under other custody can make a missing row visible relative to that book. If the second book is also short, or if membership in the window is a cross-clock question whose skew bound is undeclared, the comparison does not get to print a pass. Principle 2a forbids inflating the standing of a bound. Principle 2b forbids deciding from an undeclared bound. The method is the comparison, the five classes, and the refusal to fold `indeterminate` into clean. That is the claim. It is a conditional impossibility result under seven explicit assumptions, not an unconditional completeness theorem.
