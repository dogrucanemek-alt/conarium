# Two ledgers, one window

A method for asking whether a mediator's record is complete, without
trusting that record to answer. Twenty minutes. Postgres and a
shell are enough.

## 1. The problem

A mediator `G` writes a record `R` of the events it sees. Integrity
marks on `R` — a sequence `G` assigned, a hash `G` chained, a
signature `G` produced — show that the rows still in `R` were not
altered, reordered, or removed from the middle after they were
written. They do not show that every event that happened was
written.

That is not a software defect. If there is any path by which an
event can occur without `G` seeing it, there are two worlds in which
`R` is the same: one where the event never happened, and one where it
happened unobserved. No function of `R` alone tells those worlds
apart. Completeness of `R` with respect to what occurred is
independent of the integrity of `R`. A second account, under
different custody, is what makes the missing row visible. If that
second account is also incomplete, the honest answer is not "clean".
It is that the comparison did not decide.

That is the single-ledger blindness proposition: a bypass path plus
a record that does not depend on the bypassed event yields two
worlds that share `R`. It is a proposition, not a theorem. If the
unobserved event changes later rows `G` *does* write — a source
sequence copied into `R` — then `R` has already imported a second
account, and this setup is not blind.

## 2. The setup

Two accounts, two custodians.

**Account S** is the data source's own activity book. In Postgres
this is a pair of `pg_stat_statements` snapshots for one dedicated
role, at the start and end of a window. The source writes these
counters. The mediator does not. If one party can rewrite both
books and never publishes a result, the method cannot see the
suppression.

Each snapshot is a timestamp (the source's clock) plus, for every
statement pattern the source distinguishes, a cumulative count.
The window is the difference: patterns whose count rose, and by
how much. If any count falls, or a pattern vanishes, the source's
book was reset or evicted inside the window. The window is then
unreliable. The method stops. It does not reconcile the
surviving patterns and call the rest noise.

**Account G** is the mediator's record: which objects it named,
at which time (its own clock). Integrity of that file is checked
first, by the file format's own rules, and is out of scope here.

Custody is different by construction: S is produced by the source,
G by the mediator. A bypassed query increments S and does not
appear in G. That is the only reason the comparison can notice
it.

Do not share a database role across clients. A shared role's
counters blame the mediator for other people's queries.

## 3. The procedure

Four steps. Skipping one must not silently upgrade the result.

**Window.** Take S at `t0` and `t1`, both stamped by the source.
Collect from G the rows whose timestamps the *mediator* wrote.
Membership in the window is already a bound, and it is decided
across two clocks. Comparing those timestamps as if they were
one clock makes the failure asymmetric: a mediator clock that
trails the source moves a genuine G-row out of the window, and
the object it would have accounted for becomes "source activity
with no mediator row". That sentence is the bypass sentence.
Seconds of skew manufacture it.

**Correspondence.** An operator declares how one client-level
operation maps onto source-level statements: which patterns, a
bound on their multiplicity, which clock each side uses, and a
bound on the skew between those clocks. The mediator cannot
measure a correspondence it does not produce. A connection
pooler or an object-relational mapper is a property of the
deployment. The declaration is therefore an operator statement,
not a measurement. Write it down. Digest it. Bind the result
to that digest. If a required bound is undeclared, do not
substitute one. A default of one-to-one invents false gaps on
any deployment with a pooler. A default of zero skew invents
the accusation the two-clock problem exists to prevent.

**Exclusion.** Some source activity is not in scope: session
setup, catalog reads, a monitoring user. Exclusion is a
decision taken *before* comparison, about what will be compared
at all. It is the step through which a result can be made to
come out empty of exceptions, and it is the step that must be
the most visible. State every rule in the same declaration that
carries the multiplicity and the skew. Report the count and the
rule. A pinned exclusion is reproducible. It is not therefore
correct. A rule that drops housekeeping and a rule that drops
the statements the auditor came to see verify the same way.

**Classification.** Every remaining item in either population
gets exactly one outcome. Matching is per pattern and per
object, not per call count. One client request may legitimately
produce several source statements. One mediator row that names
an object clears an unbounded number of further statements
against that object inside the window. The procedure has then
established object attribution, and nothing stronger. A pattern
whose target objects cannot be determined is not ignored. It is
left undecided.

Example: S at 10:00 and 10:10 for role `app`. `patients` rose
by 3, `labs` by 1, `pg_catalog` rose and is excluded by a named
rule. G has two in-window rows naming `patients` and none
naming `labs`. Under a declared one-to-many bound, `patients`
is attributed. `labs` is not. The next section says what
that "not" may mean.

## 4. Five outcome classes

Each class is a statement about the comparison. None is a
statement about intent.

**Attributed (matched).** The item corresponds to an item in the
other population, inside the window, inside the declared bounds.
The two kinds of bound do not act alike. A multiplicity bound
admits items to this class. A skew bound does not: a mediator
row outside the window is never attributed, however small the
declared skew. The bound says how far the boundary can be
trusted, not where the boundary is. This class does not mean
every source statement was itself recorded by the mediator. It
does not mean the populations are complete. It does not mean
the correspondence was measured.

**Observed without a mediator row.** The source recorded activity
against an object that no in-window mediator row names. This
means evidence is absent. It does not mean bypass. It does not
mean the mediator's sink failed. It does not mean a scope
mismatch. All three produce the same shape. Investigation
attributes cause; this method does not. If the only naming row
in G sits *outside* the window, this class is the wrong one —
that case is undecided, below.

**Recorded without a source observation.** A mediator row in the
window names an object for which the source counters did not
rise. This is also a statement about evidence, not a fault. A
counter that increments outside the snapshot pair, a pooler that
collapses statements, and a row that describes activity that did
not occur have the same shape. A local policy may treat it as
failure. The method does not define it as one.

**Excluded.** Removed before matching by a rule in the
declaration. Not produced by the comparison. Report the rule.
Do not read the digest of the declaration as a judgement that
the rule was the right one.

**Undecided (`indeterminate`).** The evidence or the declaration
does not determine an outcome. The pattern's objects could not
be attributed; a required multiplicity or skew bound is
undeclared; the item's only naming mediator row falls outside
the window; or the window's evidence is insufficient to decide.
This is a result. It is not a weaker pass. It is not "probably
attributed". It is not "probably a gap".

A comparison with no "observed without a mediator row" items
establishes that each observed source item is attributable to a
mediator row naming the same object, under the declared
correspondence. It does not establish that the source's book is
complete, or that the mediator's file is complete, or that
nothing happened off both books.

## 5. Why undecided is mandatory, and why "clean" is forbidden

Two facts force the fifth class.

The first is the single-ledger fact already stated: one book
cannot testify to what it did not write. Adding a second book
does not close the world. Both can be short. A result that
has only attributed and excluded items is named, in the
published procedure, as "no exceptions under the declared
correspondence". That name says what the comparison left open,
not what it proved. Folding the leftover into "clean" asserts
completeness of both populations. The method does not have
that.

The second is the standing of the declaration. A result
computed against an operator statement cannot present that
statement as a measurement. Where a required bound is
undeclared, the comparison does not get to pick a number. The
affected items are undecided. Substituting a default decides
the operator's question with a value the operator never saw.

A third, operational, reason sits on the window. When every
object an item leaves unaccounted for is named by a mediator
row that the two clocks put outside the window, the method
cannot tell a trailing mediator clock from a late row. Reporting
"observed without a mediator row" asserts a distinction it did
not make. The item is undecided, and the offset is reported.
An item that leaves even one object named by no mediator row
*anywhere* is not rescued by a neighbour's clock. That is a
genuine absence of a naming row, and it stays in that class.

What is forbidden is resolving the undecided class by
assumption in either direction: counting it as attributed
because nothing contradicts it, or reporting it as missing
activity because nothing confirms it. Averaging it into a
coverage proportion performs the same collapse and is
forbidden for the same reason. The absence of a decision is
not a decision.

The same discipline applies one layer up to labels. A bound is
undeclared, operator-declared, measured, or protocol-enforced.
The result states which. It does not print an operator-declared
skew as measured. An operator-declared correspondence may still
attribute. It may not call the attribution a measurement. That
is a ceiling on labels, not a demand that every outcome be
undecided.

## 6. What the method does not catch

- **Same-party silence.** An operator who controls S and G and
  never publishes a result can suppress both books. Registration
  of an already-issued result with a third party makes later
  deletion visible. It does not create a result that was never
  written.
- **A falsified source book.** The method trusts the source's
  counters. An attacker who can increment, decrement, or reset
  them without a visible regression is outside it. A visible
  regression fails the window; a silent lie does not.
- **Events the source does not count.** A path that touches
  data without incrementing the book S is looking at — a
  replica, a different role, a filesystem copy, a backup
  restore — does not appear on either side.
- **Per-statement coverage.** Object attribution is weaker.
  One naming row clears the object for the window.
- **Cause.** Absent evidence is not intent, not a breach, not
  a sink failure. The shape does not distinguish them.
- **Correct exclusions.** Reproducible is not justified.
- **Truth at write time.** Integrity of G is assumed already
  checked. Even then, rows can be intact and false.
- **Prevention.** Closing the bypass path is a different
  property. The method detects. It does not block.

The output is a classified comparison of two incomplete books
over a window that sits on two clocks. Absence becomes
checkable. An undecided comparison is not rewritten as clean.
