# Changelog

## 0.2.45 - the rest of an outside report, and a check over the descriptions

**Behaviour change in `conarium-verify` and `conarium-coverage`.** Read the two
rows below before upgrading a script that branches on exit codes.

Joel Hillier probed the exit-code defect we disclosed on 22 August and found
five routes to 20 where we had named three. 0.2.44 closed three of them. This
closes the other two.

**A file that is valid JSON but not JSONL was called "invalid JSON".** The
loader splits on newlines unless the file opens with `[`, so a pretty-printed
JSON object has its opening brace handed to `JSON.parse` alone, and the tool
reported a valid file as invalid. His point was that the false message mattered
more than the code, and it does: a caller acts on what it is told went wrong.
The message now names the real fact and says how to fix it. Where a reader
actually meets this is directory mode - pointed at our own published
`test-vectors/`, the verifier reached `expected-hashes.json` and stopped. A
directory is now asked for the receipts in it: a neighbour that is valid JSON
in the wrong shape is skipped **and named on stderr**, never skipped quietly.

**The check ordering.** The key was loaded before the target was resolved, so a
path that does not exist answered 13 - a verdict about signatures, for a file
never opened - and answered 2 as soon as an unrelated `--pubkey` was supplied.
Which wrong answer a caller received was a fact about check order. The target is
resolved first now, in `conarium-verify` and `conarium-coverage`. Fail-closed is
untouched: a missing target exits 2, and a target that is present still cannot
be verified without a key.

| Invocation | 0.2.44 | 0.2.45 |
|---|---|---|
| valid JSON that is not JSONL | 20, "invalid JSON" | **2**, and the message is true |
| a directory holding receipts and a metadata file | 20 | **0**, the metadata file named as skipped |
| a missing target with no `--pubkey` | 13 | **2** |
| a corrupt receipts file | 20 | 20, unchanged |
| a missing `--pubkey` on a file that exists | 13 | 13, unchanged |

The last two rows are the split, and a property test decided where it fell. The
first attempt sent every parse failure to 2, and
`src/invariants.property.test.ts` - which mutates one byte of a signed chain -
failed. It was right to: a corrupted file is the artefact being examined and
rejected, which is a verdict, and answering 2 would send an operator to check
their arguments instead of their evidence. Valid JSON in the wrong shape is 2.
Anything else is 20, in a directory as well as out of one.

**`test/exit_code_descriptions.mjs`** is new, and it is the part worth keeping.
The same code is described in `docs/RECEIPT-SPEC.md`, in
`test-vectors/manifest.json` and in `scripts/gen-test-vectors.mjs`. It requires
the two machine-readable copies to be identical and each manifest description to
be the leading clause of the specification's row. On its first run it failed on
two things nothing else could see: the manifest and the specification describing
code 2 differently in the same release, and the manifest describing 13 as
"signature invalid or missing while a pubkey was supplied" - false in the one
case 13 is returned for, since 13 is what you get when no pubkey was supplied.

`spec_exitcode_drift.mjs` was green through all of it, because it compares the
*set* of codes in the binaries with the set in the tables. That is the blindness
Joel named after hitting the identical shape in his own `ABSENT` verdict the
same week: a check over the members of a set cannot see a member that means two
things. The new check does not close it entirely - it establishes that the three
texts agree with each other, not that any of them is true of the binary.

## 0.2.44 — a verdict code, on all four tools, now means something was read

**This is a behaviour change to every command-line tool in the package. Read
the table before upgrading a script that branches on exit codes.**

0.2.42 moved `conarium-verify`'s usage errors out of the verdict range and said
the remaining misuse of 20 was the uncaught-exception handler. That was written
from reading the file. Running it found `conarium-verify missing.jsonl` exiting
**20** — *Schema invalid* — with no receipt opened, from a `return { code: 20 }`
inside `loadReceipts`. 0.2.43 documented it. This release fixes it, and finishes
the job across the three tools that were measured in 0.2.42 and left alone.

Two codes now sit outside the verdict range, and mean the same thing on all
four binaries:

| Exit | Meaning |
|---|---|
| 1 | The tool failed unexpectedly — no verdict was reached |
| 2 | The command could not be run as given — an unknown flag, a required argument that was not given, or a target that is not there. Nothing was read. |

What moved, measured before and after:

| Invocation | 0.2.43 | 0.2.44 |
|---|---|---|
| `conarium-verify <missing path>` | 20 | **2** |
| `conarium-coverage` — unknown flag, missing argument, missing declaration or receipts file | 20 | **2** |
| `conarium-reconcile` — unknown flag, missing flags, missing snapshot, receipts or profile | 20 | **2** |
| `conarium-stamp` — unknown flag, missing argument, missing or unreadable target | 20 | **2** |
| all four — uncaught exception | 20 | **1** |

Unchanged, and asserted in the same test run so the release cannot trade one
wrong answer for another: a valid chain is 0, a schema failure on a receipt that
was read is 20, a bad signature is 13, and **a missing `--pubkey` is still 13**.
That last one is a usage mistake by any ordinary reading, and it stays a verdict
on purpose: 13 is fail-closed, a script that has special-cased it is asserting
*do not trust this*, and moving it to 2 would turn that assertion off in the
name of tidiness. `--help` is 0 on all four.

**Who breaks.** A script reading 20 as "schema invalid" was already folding
typos and missing files into that bucket; those now arrive as 2, and genuine
schema failures are unaffected. A script treating any non-zero as failure sees
no change. A script that branches on 20 to page a human about a malformed
receipt will now page correctly — the missing-file case that used to reach it
was never a malformed receipt.

`test/exit_contract.mjs` is new and runs all four binaries: twelve invocations
that reach no artefact, nine verdicts and `--help` cases that must not move. It
was written first and failed on eleven of the twelve, which is the record of
what this release actually changed. The uncaught-exception path is the one line
here not covered by it — no CLI input reaches that handler, which is why it is
last-resort, and the change is covered by reading rather than by a run. Said
plainly rather than implied by an untested green.

## 0.2.43 — the number watching the Turkish was reporting a third of it

`test/pack_locale.mjs` has always ended with a line naming what it does *not*
fix: Turkish left under `docs/`, out of interface scope, printed so it stays
visible. The line read `324 occurrences across 22 files`. The letter pass finds
**1034 lines across 29 files**. The remainder was counted by `wordProbe` alone —
the pass written for Turkish that carries *no* Turkish letter, and therefore the
wrong instrument for Turkish prose. Both passes now run and the union is
reported.

What the package was shipping under that number: `docs/superpowers/`,
`docs/plans/`, `docs/specs/` and `docs/audit/` — dated internal design and
process documents, in Turkish, including plan files whose first instruction is
addressed to an agent rather than to a reader. They are out of the package, the
way `docs/reviews` and `docs/teaching` already were. **243 packed paths, down
from 257.** The remainder is **34 lines across 14 files**: the bilingual
limitation paragraphs in `README.md` and `docs/RECEIPT-SPEC.md`, product strings
quoted in this changelog, and a TURKPATENT citation in `docs/PRIOR-ART.md`.

Two sentences were translated rather than dropped: the specification test in
`conformance/README.md`, and a Turkish parenthetical inside an English paragraph
of `docs/RECEIPT-SPEC.md`.

The remainder is now **pinned** in `docs/claims/locale-residue.json` and the
guard fails when the tree disagrees with it — in either direction. A printed
number nobody compares against anything is how this one drifted through three
releases; it was copied into a handover note as `308 / 19`, a figure that
reproduces under no definition and matched no release.

`test/pack_path_refs.mjs` is new. Dropping `docs/superpowers/` turned the
"Design source:" line at the top of `docs/RECEIPT-SPEC.md` into a path a reader
who installed the package cannot open — a dead reference created by a packaging
change, with no character of that sentence edited. The check reads the documents
npm packs and fails when one names a path that exists in the repository and not
in the package. It only considers directories the package *partially* ships:
`src/` and `test/` are wholly absent and always were, and a check that reports
those is a check that gets switched off.

## 0.2.42 — a usage error is not a schema verdict

`conarium-verify` exited **20** for an unknown flag and for a missing path.
The published tables give 20 one meaning: *Schema invalid*. A machine that
typed the command wrong was therefore handed a verdict about a receipt it
had never opened. That is the same shape as the 0.2.40 `--anchor-check`
defect: the code named an event that had not occurred.

Usage errors are now **2**, which sits outside the verdict range (10–20).
A real schema failure — vector 007, or `fail(20, …)` after a receipt is
read — is still 20. The uncaught-exception path at the bottom of the file
is also still 20; it is not a schema diagnosis, and this release does not
rename it.

Nor is a target that is not there. `conarium-verify missing.jsonl --pubkey
<key>` prints `path not found` and exits **20**, having opened no receipt.
That is the same defect one path over, and this release does not fix it:
whether an unreachable input is a usage error, a verdict, or a third thing
is a decision about the exit-code contract, not a typo. It is written down
in `docs/RECEIPT-SPEC.md` where the table can be read against the binary,
and it is the next change to this file.

**This is a behaviour change.** A script that treated every 20 as "schema
invalid" was already folding typos into that bucket. Those typos will now
be 2. Schema-invalid inputs are unaffected.

`conarium-coverage`, `conarium-reconcile` and `conarium-stamp` still exit
20 on usage errors. They were measured, not changed.

## 0.2.41 — a limit that was announced in the wrong place

Since 0.2.34 `docs/RECEIPT-SPEC.md` had carried a stated limit: the thirteen
receipt vectors are ASCII-keyed with integer and string values, a naive
sorted-key serialiser reproduces all thirteen hashes, and so matching them does
not demonstrate a conforming JCS implementation. That much was true, and stays
true.

The remedy named in the same paragraph was not. It said the disagreement would
first appear in "a receipt carrying a float, a large integer, or a non-ASCII
key". No such receipt can exist. The receipt body is a fixed shape whose only
numbers are `chain.seq`, `masking.pii` and `outcome.rows` — small integers — and
every key in it is ASCII. The paragraph described a vector nobody could write.

Caller-shaped JSON reaches canonicalisation at one point: `hashArgs()`, whose
argument is typed `any` and whose digest becomes `request.argsHash`. That is
where a second implementation can disagree with us, and its preimages were
published nowhere — vector 001 carries `sha256:abab...`, a placeholder standing
in for a hash of nothing.

`test-vectors/jcs/` now publishes eight preimages with frozen hashes: floats at
the `1e21` exponent boundary and the denormal minimum, integers past 2^53,
non-ASCII keys, a surrogate-pair sort order, the escape rules, and the
raw-string branch — where `hashArgs` digests the bytes it was handed rather than
canonicalising them, which is the case most likely to split two implementations
that otherwise agree.

`test/spec_jcs_class.mjs` measures our own conformance against the reference
data published with RFC 8785: six input/expected pairs compared over bytes, and
3,000 of its published IEEE-754 doubles. All pass. The number evidence is a
**sample** of 100,000,000 and says so wherever it is cited. The guard also runs
eight mutants and fails if any of them reproduces the reference bytes, because
three checks in this repository have now reported success without comparing
anything, and the fix for that is not a fourth check that could do the same.

No behaviour changed. The verifier, the canonical form and all thirteen receipt
vectors are byte-identical to 0.2.40.

## 0.2.40 — an exit code that answered a question it had not examined

`conarium-verify --anchor-check` over a chain where every receipt is unanchored
exited **0**. Each null anchor was skipped, which is correct — periodic anchoring
leaves most receipts null and failing on that would make the flag unusable. What
followed was not: with nothing left to compare, the run reported success. A
caller who asked whether the anchors held was answered by a code path that never
reached an anchor.

The count was always printed — the summary line said `0/N anchored` — so the
information was on screen. The exit code was the part that claimed more than had
been examined, and the exit code is what a machine reads.

It is now **15**, which already means "could not be checked" and is evaluated
ahead of 14 so that "I could not check" is never swallowed by "it does not hold".
`--require-head-anchor` keeps 14: there the caller asserted an anchor must be
present, and its absence is a failed assertion rather than an unread one. A chain
carrying at least one anchor is unaffected.

**This is a behaviour change.** A caller who ran `--anchor-check` over
never-anchored chains and treated 0 as success will now see 15. That is the
point — but it is a break, and it is why this is a version rather than a patch to
the last one.

The old answer was not an oversight: `test/anchor_verify.mjs` A6.5 asserted it.
The test had written the defect down, so the behaviour changed and the
expectation was corrected — the opposite of vector 008, where the implementation
was right and the expectation was wrong. A6.9 adds the multi-receipt case and a
control proving that a run which never asked about anchors still exits 0.

Found by applying a rule from the SCITT list to our own tool: a checker must
report that it did not compare, rather than return a verdict it did not earn.

Also here: four more Turkish identifiers in `bin/conarium-verify.mjs`
(`modelBildirilmemis`, `clientBildirilmemis`, `notlar`, `ek`) that 0.2.39's word
pass did not carry in its list. Translated, and the words added — which is the
second time that list has grown by being wrong, and is exactly the limit recorded
against it.

## 0.2.39 — 2026-08-21 — the package speaks the language its documentation is written in

The executable package carried operational text in Turkish. Not in the
documentation, which has always been English, and not in the specification — in
the running code, where a reader who installs the package meets it.

The sharpest instance: a gateway started without a token printed
`CONARIUM_MCP_TOKEN eksik ya da <24 karakter — fail-closed, baslamiyorum.` That
is the first sentence an unaffiliated operator sees when their configuration is
wrong, and it was unreadable to most of them. The receipt viewer rendered
`lang="tr"` and translated its own labels into Turkish through a presentation
map. The console UI in `public/` said `Yukleniyor...` and `zincir saglam`. The
reasoning comments throughout `src/` — the part of this repository that explains
why a thing is written the way it is, and the part with the most value to anyone
extending it — were Turkish, and `tsc` carried them into `dist/`.

This project claims to be implementable without us. A code base whose reasoning
cannot be read by the people expected to implement it is a claim that was never
measured. Nothing here changes behaviour: strings, comments, `lang`, and the
presentation map whose values are now its keys. Thresholds, conditions and
identifiers are untouched, including the Turkish tokens the PII detectors match
on and the record-kind name they emit, which are data rather than prose.

`test/pack_locale.mjs` keeps it that way. It reads the file list `npm pack`
would ship and fails on Turkish-specific letters outside a narrow allow-list:
the deliberately Turkish `*.tr.md`, the detector tokens, and the sample names
the locale tests pin. It was shown failing before it was wired in, and again
from a comment added to `src/http.ts` and carried into `dist/http.js` by a
build, which is the path that put the text there in the first place.

Two limits, stated rather than left to be found. The check tests for Turkish
letters, not Turkish language: a sentence written without them passes. And the
markdown that ships alongside the code — the changelog's own history, parts of
`docs/` — is still Turkish in places and is a second pass, not this one.

## 0.2.38 — 2026-08-20 — the conditional sentence that two other pages forgot

The receipt is opt-in. Nothing is written until a receipt sink is configured, and
`conarium-init` configures one, so the default layout has receipts and a
hand-written config need not. The top of the README has said so since 0.2.32.

Two other places had not caught up. `README.md` listed "Ed25519-signed receipt per
access" among what ships, with no condition attached — the same file contradicting
itself sixty lines apart. `docs/security/THREAT-MODEL.md` said every tool call "is
supposed to write a signed receipt", which is the one document where an unstated
precondition matters most: a reader consults a threat model to learn what the system
does *not* guarantee.

Both now name the condition. The threat model also gains the bypass it implies: a
gateway with no sink mediates access and leaves no evidence, and it starts either
way.

The verification quickstart now fetches its three proof files from `conarium.dev`
instead of `demo.conarium.dev`. The bytes are identical; the difference is that the
first command a newcomer runs no longer depends on a single machine that also runs
unrelated services.

Nothing in `src/` changed. This release is three sentences and an address.

## 0.2.37 — 2026-08-20 — a claim with no call site, and the bound that decided anyway

`docs/RECEIPT-SPEC.md` said "Receipts are anchored automatically." Nothing in
`src/` or `bin/` called the anchor scheduler: `Audit.writeReceipt` emits
`anchor: null`, and `createAnchorSinkFromEnv`, `maybeAnchor` and
`appendAnchorSidecar` had no production caller outside their own definitions.
Anchoring is a manual step — `conarium-stamp` for a document,
`conarium-anchor-service` for a chain head — and the sentence now says so, in
`README.md`, `LIMITATIONS.md`, `docs/ARCHITECTURE.md` and the stamp tool's own
header, which repeated it. The scheduler was not wired: adding an outbound hop to
the receipt path is a product decision, not a way to make a sentence true.
`test/anchor_wiring.mjs` refuses an automatic-anchoring claim on a claim surface
unless a write call exists in `src/` or `bin/`.

`conarium-reconcile` now emits `coverage-reconciliation/2` as a separate object
(`--json-v2`, `--result-v2 <path>`), alongside the `/1` body and the exit codes,
which are unchanged. The `/2` object carries `profile`, `bounds`, `outcome`,
`items` and `counts` as the published draft defines them, and it stops treating
undeclared bounds as decisions: with no Mapping Profile, a multiplicity-dependent
item is `indeterminate` rather than `matched`, an unattributed pattern is
`indeterminate` rather than `observed-without-receipt`, an infrastructure pattern
is `indeterminate` rather than `excluded`, and a `receipted-without-observation`
item makes the outcome `exceptions`. A `/1` result is not a `/2` result and the
two cannot share a body; asking for both at once is an error.

A Mapping Profile (`conarium-mapping-profile/0.1`, `--profile`) declares the
multiplicity bound, the exclusion rules, and the two clocks: which clock stamps
the observation window, which stamps receipts, and how far they may differ.
`clocks.skew` uses the same duration grammar as `--skew` — there is not a second
one — and if both are present and disagree the run fails rather than picking one,
because which bound won would be invisible on the result. The field list and its
encoding are written out in `docs/RECEIPT-SPEC.md` so another specification can
adopt the shape instead of inventing a second.

The claim-surface list lived in two hand-maintained copies, which is the shape
that produced most of 0.2.36. It is one file now, `docs/claims/surfaces.json`,
read by both the review gate and the retracted-phrasing scan, with a stated
reason per entry and no silent exemptions. `LIMITATIONS.tr.md` was three sections
short of `LIMITATIONS.md`; the sections were written and a check now compares the
two by section key, so a limitation cannot reach one language and not the other.

## 0.2.36 — 2026-08-20 — the lock that could be taken twice

The receipt sink had no lock of its own. `Audit` took one on the audit sink at
construct time, and receipts were written to a different path — so a receipt-only
install took no lock at all, and two processes with different audit sinks sharing
one receipt file took two locks over one file. Both configurations forked `seq`
and `prevHash`, and a forked chain does not verify. `log()` now takes every sink
path it is about to write, in lexicographic path order (one fixed order, so two
locks cannot deadlock), and re-reads the receipt tail under that lock instead of
trusting what the instance loaded at startup.

Fixing that exposed an older defect in the lock itself. The lock file is created
and the owner pid is written into it a syscall later; a second process arriving
inside that gap saw the file exist with an empty body, could not read an owner,
and treated it as abandoned — so it deleted a live process's lock and took the
sink. The guard added on 15 August to "reject a second OS process" therefore
rejected it most of the time, not always, and its test never landed in the gap.
An unreadable lock is now honoured rather than stolen until it is 30s old, which
still reclaims a lock whose owner died, and a lock naming a dead pid is still
reclaimed at once. The bounded cost is stated in the threat model: a process that
dies inside that same gap blocks its sink, and access with it, for those 30s.

Also: a check that compares what `standards/README.md` says about the draft with
what the IETF Datatracker says — unreachable is a printed SKIP, a mismatch is
red. Three sentences that had gone stale were rewritten to point at what holds
the state instead of restating it: outbound connections are now named with the
variables that disable them, draft status defers to the Datatracker, and the
receipt claim in `README.md` and in the package description says when receipts
are written rather than implying always.

## 0.2.35 — 2026-08-20 — two sentences that our own actions made false

Nothing in the engine changed. This release exists because publishing 0.2.34
invalidated a paragraph inside 0.2.34, which is a small thing that says something
about how documentation ages here.

- **`docs/security/NPM-PROVENANCE.md` said the full publish path had not run
  yet.** It ran a few hours later, publishing 0.2.34 itself. The page now
  separates the two histories: 0.2.33 carries a tarball and an attestation and no
  bill of materials, because its artefacts were attached by the mode that skips
  that step; 0.2.34 carries all three because the full path produced them. The
  paragraph ends by pointing at the release page rather than at itself, which is
  the only version of this sentence that does not expire.
- **The OpenSSF Best Practices badge is in the README, with what it is not.**
  The project earned the passing badge on 2026-08-19 (project 14160, 64 of 67
  criteria met, 3 not applicable and stated as such). The README says in the same
  breath that this is self-certification rather than an audit, that the answers
  are public and checkable, and that the Scorecard badge beside it carries a
  `Code-Review` score of 0 because pull requests here are merged without a second
  approver. A badge added without that sentence would be the kind of claim this
  package spends its time refusing.
- One criterion was corrected before it was submitted rather than after: the
  first answer for "the test suite covers most of the code" asserted coverage
  that had never been measured. It now describes what is exercised and says the
  ratio is not reported.

## 0.2.34 — 2026-08-19 — the prior-art claim that got narrower

A comparative claim in this package was too strong, and the correction came from
reading a competitor's source rather than from a gate of ours catching it.

- **`docs/PRIOR-ART.md` no longer says nobody else has arrived at the idea.**
  Vaara (`vaaraio/vaara`, AGPL-3.0) specifies a coverage reconciliation in
  `credential-broker-spec.md` §D — joining each used credential to the receipt it
  should have produced, and reading a mismatch as a bypassed broker — with its
  limits stated in §E. The row is scored from source: the tree at `befdced` was
  cloned, its contiguity tests run, and searched for code implementing that
  design. None was found, so the column reads **"specified, not found
  implemented"** rather than yes.
- **That row was scored twice, and the first scoring is left on the page.** It
  first read "Yes", on the strength of the design section alone — scoring a
  specification as behaviour, which is the confusion this file's own column
  definitions warn about two sections above. The correction is recorded where the
  row is, not quietly.
- **What survives is stated in the narrower form.** The claim stands on
  implementation, which is what every other row is scored on. What it can no
  longer carry is that nobody else has had the idea. Anyone quoting the file
  should quote *"we have not found another implementation that masks values
  before the model sees them and then reconciles what it disclosed"* — not
  *"nobody else reconciles"* and not *"none of the ten has the third column"*.
- **The Microsoft row said "Merkle-chained" and their tutorial describes a linear
  `parent_receipt_hash`.** Overstating a competitor's mechanism is the same defect
  as overstating our own, so it is corrected in the same pass.
- **`README.md` says eleven projects, and says which way the eleventh moved the
  claim.** A comparison page that only ever gains rows it wins is not evidence.
- **`docs/security/NPM-PROVENANCE.md` documents the three release artefacts the
  full publish path is configured to produce** — the published tarball, a
  CycloneDX bill of materials, and a build attestation written to GitHub's
  attestation store — and says which of them any given release actually carries.
  The artefact path first ran on 19 August in `artefacts` mode against 0.2.33,
  which now carries the tarball and the attestation but no bill of materials.
- **The changelog had stopped one version short of the package again**: 0.2.33
  shipped before its entry was written, and that entry is below. The publish
  workflow now refuses a version whose section does not exist, so the next
  occurrence is a red gate rather than a discovery.

## 0.2.33 — 2026-08-19

Written on 2026-08-19, after 0.2.33 had already shipped without it. The gap is
recorded rather than backdated.

- **The provenance page stopped saying there was nothing to verify.**
  `docs/security/NPM-PROVENANCE.md` still read *"This is not a published
  release"* eight releases after the first one, and pointed readers at
  `gh attestation verify`, which answers `404` for a package published with npm
  provenance — that command reads GitHub's attestation store, while
  `npm publish --provenance` writes to the npm registry and its transparency log.
  A reader checking the honest way would have read that 404 as "no attestation",
  which is the opposite of the truth.
- The working commands replaced it: `npm view … dist --json`, which returns the
  `attestations` block naming `slsa.dev/provenance/v1`, and `npm audit
  signatures`. The `gh` command stayed on the page as a warning with its reason,
  because a reader who tries it deserves to know why it fails.
- Found by an external review, not by our own claim gate. The gate locks phrasings
  already caught; this file was never in the list of surfaces it reads.

## 0.2.32 — 2026-08-19

Tool descriptions now say what the tools do to the world, not just what they are
for. A client picks a tool from its description, and all four of ours left out
the three things a caller needs before making the call: that the operation is
read-only, what shape comes back, and that the result has already been altered by
policy.

- **`query` and `search` state that values arrive masked.** A caller that plans
  on receiving a raw column and gets `[MASKED_PII]` has been surprised by the
  product working correctly. Both now say so up front, along with the row cap
  being the policy's rather than the one written into the SQL.
- **`describe_table` states that it reads no rows**, so nothing it returns is
  masked — a distinction that was invisible from the outside.
- **`list_tables` states that denied tables are absent rather than flagged**, so
  its output is the authoritative list of what the other tools can reach.
- Each description now names the sibling to prefer, in the direction the mistake
  actually gets made: `query` points to `search` when there is no SELECT yet.
- Added `glama.json`, which is how the directory listing is claimed by its
  maintainer.

This changelog also stops three versions short of the package. Entries for
0.2.29, 0.2.30 and 0.2.31 are below, written from their release notes. A file
that ships in the tarball and describes a state the package left two releases ago
is worse than no file: the reader has no way to know it is stale.

## 0.2.31 — 2026-08-19

- **A masking fix that was five times slower outside ASCII.** Both of its
  fast-path conditions were guarded on an ASCII test, so Turkish data satisfied
  neither and the regex recompiled for every (value, cell) pair. The regression
  test counts compilations through a `RegExp` proxy rather than measuring time,
  because a millisecond threshold passes or fails on the machine that runs it.
  Output is byte-identical across all four measured shapes.
- **Benchmark figures re-measured and the environment named beside them.** The
  masking warning threshold moved from 100 to 500 rows, read from
  `docs/benchmarks/masking-cost-threshold.json` rather than a second copy.
- **The published IETF `-04` and the repository `-04` are the same text again.**
  The repository copy predated the submission by two paragraphs, including the
  acknowledgement a reviewer had asked for.
- **The package stopped telling readers to buy something they cannot buy.**
  `/buy` redirects to the waitlist form while checkout is closed; README and
  `docs/PRICING.md` now say that, and each edit names the condition that reverses
  it. `docs/PRICING.md` was added to the claim surface list — it states a price
  and a refund window and had no assigned reader.

## 0.2.30 — 2026-08-18

Three fields in the signed receipt were named for something other than their
contents, found by an external review of 0.2.28.

- **`actor.type` was the constant `service`.** A person connecting with their own
  per-user token produced a receipt naming them and stamping them a service. The
  type is now derived from `assurance` in one place rather than carried twice.
- **`dataRefs[].fieldsRequested` and `policy.rulesApplied` are now empty.** They
  were filled from the masked-field list and from the SQL functions a query
  touched — neither is what the name says, and both were signed. In a signed
  document a field filled with the wrong thing is worse than one left empty.
- The cost is stated rather than absorbed: per-field masking detail leaves
  `dataRefs`; `masking.byClass` still carries the per-class counts.

## 0.2.29 — 2026-08-18

- **`docs.html` said two different things about the same engine.** The site
  described behaviour the engine denies; the wording was brought back to what the
  code does, and the retracted phrasings moved to a single source
  (`docs/claims/retracted-phrasings.json`) that ships with the package.
- **The SOC 2 answer reached the Turkish surface.** `LIMITATIONS.tr.md` still
  said the audit was on the roadmap after that had been retracted everywhere
  else — the guard could not see it because the sentence was in another language.
- `docs/reviews` excluded from the tarball; GACS drift check added.

## 0.2.28 — 2026-08-17

The `indeterminate` class added in 0.2.27 was attacked the same day, and the
attack got through. A legitimate receipt from the previous day, naming the same
table, turned a real in-window bypass from exit 40 into 41 — and the run then
said the access was **"NOT reported as unreceipted access"**. 41 is not a silent
pass, and was not one then: the run still fails and CI still goes red. The damage
was the sentence. At three seconds it is true; at twenty-three hours it points
the reader away from what happened.

- **The exculpation is bounded by the window's own length.** An offset larger
  than `after.ts − before.ts` cannot be a boundary artefact, so the boundary is
  no longer offered as the explanation. The pattern stays `indeterminate` at 41,
  because the tool still cannot say which access that receipt belongs to, and the
  report says so in those terms: *"a boundary artefact cannot explain an offset
  larger than the window itself … NOT excused as a timing effect."*

- **The threshold is derived, not chosen.** It is the window the caller supplied.
  A number picked by us would be the kind of number this tool exists to refuse.

- **A declared `--skew` outranks it.** A five-second window with a six-second NTP
  step is a real case, and the operator is the one who knows their clocks.

- **The 0.2.27 fix is unchanged.** A genuinely skewed receipt three seconds
  outside a two-hour window still reads as the boundary, still exits 41, and
  still is not called a bypass. A pattern with even one table that has no receipt
  anywhere still exits 40 with the bypass sentence.

Found by an adversarial review commissioned after the fix shipped, on the ground
that the fix had loosened a guard's default and its author should not be the one
clearing it.

## 0.2.27 — 2026-08-17

`conarium-reconcile` could accuse the gateway of being bypassed because two
clocks disagreed by three seconds. Raised by Walter Hawkins on the IETF SCITT
list against `bin/conarium-reconcile.mjs` on main, and reproduced before it was
changed.

- **The window straddles two clocks, and the comparison was exact.** The window
  is `[before.ts, after.ts]`, both from the database; a receipt's `ts` comes from
  the gateway. A receipt three seconds early was counted `outOfWindow`, the table
  it covered landed in `uncovered`, and the run exited 40 with "the gateway may
  have been bypassed". The failure is asymmetric: skew manufactures the
  accusation rather than any real gap, and the sub-second version is the
  dangerous one, because it is believed.

- **The missing piece was qualification, not observation.** The tool already
  counted those receipts; nothing asked how far outside they were, so a receipt
  three seconds early and one six hours early produced the same verdict. A
  pattern whose uncovered tables all have a receipt just outside the boundary is
  now `indeterminate`, exit **41**, and the report names the skew that would have
  to be true for it. 41 is a failure, not a pass — what it is not is an
  accusation.

- **`--skew <duration>` declares the bound** (`500ms`, `5s`, `2m`, `1h`). Beyond
  it, a receipt is not skew and its pattern stays unreconciled at 40. Without it
  nothing decides the question, so nothing is asserted. An unreadable duration is
  an error rather than a default: a tolerance nobody chose is the kind of number
  this tool exists to refuse.

- **A real gap stays a real gap.** If even one uncovered table has no receipt
  anywhere, the pattern remains unreconciled. A genuine finding is not made
  indeterminate by a neighbour's clock.

## 0.2.26 — 2026-08-17

The claim list that `test/claim_discipline.mjs` enforces now ships in the
package, because the live site is a different repository and `test/` is not
published. Copying the list into the site would have been a second source;
the next overclaim would have been the two lists drifting.

- **Retracted phrasings are a published file.**
  `docs/claims/retracted-phrasings.json` is the only list. The test reads it.
  The site repository reads the same file from
  `node_modules/conarium-core/docs/claims/`. If the installed package does not
  carry it, the site check is red and says to update the package. It does not
  skip.

- **SOC 2 is the word, not an English suffix.** The previous pattern looked
  for `ready|compliant|certified` within twelve characters. The live site
  said `SOC2 & DSGVO-konform`, `SOC2 et RGPD`, `SOC2和GDPR要求` — and the
  check was green. The honest sentence is still allowed: `No SOC 2`,
  `SOC 2 yok`, and the same denial in the languages the site speaks.

## 0.2.25 — 2026-08-17

A documented command was never installed. It was found by running the README on a
machine that had never seen this package — the one path no test had walked, because
every test walks it from the repository, where the paths resolve.

- **`npx conarium-anchor-service` resolves.** The countersigning endpoint was
  documented in the README, shipped in the tarball as
  `bin/conarium-anchor-service.mjs`, correctly shebanged, and fail-closed on
  missing configuration. It was never listed in package.json `bin`, so npm looked
  for a package by that name in the registry and answered E404 — for as long as
  the file had existed. It is registered now; starting it without a token file or
  a signing key exits 2 and names what is missing, as the README says it does.

- **Documented commands are checked against installed commands, both ways.**
  `test/bin_claims.mjs` reads the `npx conarium-*` invocations out of README,
  SECURITY, LIMITATIONS and `docs/` and fails when one of them is absent from
  package.json `bin`; it also asserts every registered bin exists and carries a
  shebang. Neither list is restated in the test. A `stranger-install` CI job
  installs the packed tarball into an empty directory and checks the opposite
  direction — that every registered command resolves without asking the registry.
  A loop over `bin` cannot catch an unregistered name, and an offline test cannot
  see how npm resolves after install, so both directions are needed.

- **The README's commands run where the README puts them.** Four blocks were
  command references written as if they were sequences. `conarium-init` writes keys
  and config, not receipts, so three `conarium-verify` lines answered 20 on a file
  that does not exist yet; `declaration.json` and the `pg_stat_statements`
  snapshots are not generated either; the repository ships a
  `conarium.config.json`, so `node bin/conarium-init.mjs` correctly refused to
  overwrite it and exited 1; and `conarium-doctor` was placed before the step that
  points the config at a DSN, so it reported the placeholder host unreachable. The
  runnable commands now use the demo chain the reader downloaded in the section
  above, and the exit codes are stated — including `--anchor-check` answering 14 on
  a chain that ships without a sidecar, which is the intended answer, since an
  absent anchor is not a verified one. The rest name their prerequisites instead
  of implying they have none.

- **Policy pages no longer assert past their own inventory.** `privacy.html` said
  "We never receive, see, or store your data or your customers' data" and then
  itemised the waitlist email it stores, the chat it forwards to a third-party
  model, and the host logs it keeps; `terms.html` made the same claim with no
  itemisation at all. The self-hosted claim is true and kept, now scoped to what
  it covers: the data Conarium governs never reaches us. `test/claim_discipline.mjs`
  had been reading both files and could not see this, because it only knows
  phrasings already caught — the phrasing is in it now.

## 0.2.24 — 2026-08-17

Documentation that shipped with 0.2.23 still carried claims this project had
already retracted, and the reason it could is now checked rather than remembered.

- **The published claims match the repository's.** 0.2.23 went to npm, and README,
  SECURITY, LIMITATIONS and the architecture note were corrected afterwards on the
  same version number. Anyone installing 0.2.23 received the corrected code with
  the uncorrected wording: "Immutable Audit Ledger", "never sees your secrets",
  "without exposing a single secret", "every access is logged". This release
  carries the corrections. `README` now says what the mechanism establishes —
  the ledger is tamper-evident rather than immutable, because a hash chain makes
  alteration and mid-chain removal detectable and does not make the file
  impossible to delete; masking hides a value and does not make it unlearnable,
  which is what `protectedColumns` narrows and `LIMITATIONS` states.

- **A version number is a claim, so it is checked.** `test/version_claim.mjs`
  fails when a release tag exists for the version in package.json and any file npm
  would ship differs from that tag. The file list comes from `npm pack --dry-run`
  rather than a second copy of the `files` array, because a restated list is one
  more hand-written claim that can drift. This is the check that would have caught
  both 0.2.21 and 0.2.23 the same day instead of a day later.

- **`engines` is Node >=20, and every major it covers is exercised.** It said >=18,
  which was wrong rather than unverified: the MCP SDK's HTTP transport uses the
  global `crypto`, available without a flag only from Node 19, so on Node 18 the
  gateway failed at `initialize`. CI now runs the suite on 20, 22 and 24, plus the
  documented first-run path on each. Node 18 and Node 20 are both past end-of-life;
  20 is kept because it is verified to work, and LIMITATIONS says so and names 22+.

- **SECURITY.md no longer contradicts LIMITATIONS** about whether a
  Conarium-operated countersigning endpoint exists. It has since 2026-08-15; one
  document was updated and the other was not, and `test/claim_discipline.mjs` now
  fails on that specific pair of statements.

## 0.2.23 — 2026-08-17

A property run found the first item at random; the second is a gap this project
stated publicly before it closed it.

- **A column literally named `__proto__` no longer breaks the request.** In
  JavaScript, `obj["__proto__"] = value` does not create a field — it replaces the
  object's prototype — and reading the same key returns the prototype rather than a
  stored value. Both halves were in the masking path: the read made `redact` throw
  (`aliases['__proto__']` resolved to `Object.prototype`, and a `.trim()` on it is a
  TypeError), and the write dropped the field from nested masking and from console
  redaction. A data source is free to return such a key: PostgreSQL accepts the
  column name, and JSON from an OpenAPI or REST connector can carry it. Writes and
  reads of caller-supplied field names now go through `setOwn` / `getOwn`
  (`src/safe-object.ts`), so the field stays a field and the prototype is untouched.
  There was no leak and no hash divergence — the request failed before producing
  output — but a governance product that drops or chokes on a column contradicts
  what it says about recording every access. Rows without such a key are byte-for-byte
  unchanged, and a test pins that (same payload, same disclosure hash).

- **Reconciliation reports receipts the counters never saw.** A receipt naming an
  object while the database shows no increase for it is now listed as UNOBSERVED,
  separately from `unassigned` (a receipt naming nothing at all) and from
  UNRECONCILED (activity the database recorded with no covering receipt). It does
  **not** change the exit code, and that is deliberate: a stats reset at the window
  edge, a connection pooler, or a count landing outside the snapshot pair produces
  the same shape, so treating every such receipt as a failure has not been shown to
  be the right rule. The category was named in a review on the IETF SCITT list as
  one our vocabulary lacked; this makes the gap visible rather than absent.

## 0.2.22 — 2026-08-16

Two corrections, both to places where something was stated or shipped without
anyone having gone back to check it.

- **Reconciliation reports object attribution, not coverage.** A review on the IETF
  SCITT list pointed out that `conarium-reconcile` printed "every DB query pattern in
  the window is covered by receipts", and the specification asked "is every bit of it
  receipted?" — while the procedure establishes neither. One receipt naming a table
  clears any number of further statements against that table inside the window;
  `test/reconcile_cli.test.mjs` is a deliberate positive case with a delta of five
  calls and one receipt. Counts are still not compared 1:1 and will not be: one client
  request can produce several source statements, and a 1:1 rule would report false
  uncovered activity on any deployment behind a connection pooler. The error was not
  refusing 1:1; it was treating existence as the alternative. A clean run now prints
  what it establishes, and the limit is written in LIMITATIONS.md. The dogfood
  transcript keeps the line it originally printed, with a correction beside it.

- **A bare container answers instead of exiting at boot.** Conarium refuses to start
  when it cannot sign audit entries, which is correct and unchanged. The image was not
  prepared for its own rule: started with nothing mounted, it died before it could
  answer a single MCP request — so a directory's health check, or anyone running the
  image to see what the tools are, saw a crash. The entry point now mints a throwaway
  Ed25519 key when none is configured, prefixed `ephemeral-container-` so a receipt
  made with it says what it came from, and warns on stderr. Mounting a key skips the
  path entirely. Nothing in CI built the Dockerfile before; a workflow now builds the
  image and requires a bare container to list its tools.

## 0.2.21 — 2026-08-16

Findings from an independent review that cloned the repository, installed it and ran
the tests, the hardening checks and the conformance suite on its own machine. None of
the four is a vulnerability: one is a claim this project stated less carefully than it
states everything else, and three are places where a misconfiguration could stay quiet.

- **The IETF draft is described as what it is.** The README said only that
  `draft-dogru-scitt-disclosure-evidence` is "on the IETF Datatracker." A reader's
  legal or security team can take that for a standards process; the Datatracker page
  itself says the opposite. It now reads: individual submission, not adopted by a
  working group, no formal standing — an Internet-Draft is a dated public record, not
  a standard. Published so the receipt format can be implemented without us.

- **The production profile announces what it changes.** Selecting
  `profile: production` quietly turned on the OpenTimestamps anchor sink when none was
  set, which means an outbound HTTPS connection, and quietly set
  `CONARIUM_AUDIT_REQUIRE_SIG=1`. Both are documented and `conarium-doctor` reports
  them, but an operator who does not run the doctor never saw it happen. Each implicit
  change now prints one line to stderr — never stdout, which would corrupt the MCP
  stream — and nothing is printed when the operator set the value themselves. This
  README says elsewhere that a governance product making an undisclosed outbound
  connection has already lost the argument; that sentence should apply to itself.

- **`doctor` warns when a masked column is not a protected one.** A column in
  `maskColumns` but not in `protectedColumns` leaves exactly the inference channel
  LIMITATIONS describes: the value is hidden, and a predicate on it still answers
  questions about it. That can be a deliberate choice, so this is a warning and not a
  refusal — it exists to make sure it is a choice.

- **`doctor` tests a custom pattern instead of only compiling it.** A rule may now
  carry an optional `sample`. A pattern that compiles but does not match its own
  sample is a warning; a pattern with no sample is reported as untested rather than
  passing silently. Neither the pattern nor the sample is ever printed. Compiling is
  not catching, and a typo in a customer-specific rule used to protect nothing while
  looking healthy.

- Contributing docs now carry the rule the four findings share: a setting that weakens
  a protection has to be noisy — in the receipt, in the doctor, and at startup.

## 0.2.20 — 2026-08-16

- **`policy.protectedColumns`: a column you may read but not ask about.**
  `maskColumns` hides a value in the result. LIMITATIONS has always said what
  that leaves open: `WHERE email LIKE 'a%'` still reaches the database, and one
  row versus none answers a question about the value it never printed. The
  answer until now was to refuse the whole table. A column listed in
  `protectedColumns` is the narrower answer — same glob syntax, still masked on
  the way out, but the query is refused before it reaches the database if the
  column appears in `WHERE`, `HAVING`, `JOIN … ON`, `ORDER BY`, `GROUP BY`,
  `SELECT DISTINCT`, or a derived `SELECT` expression. Aliases, CTEs, table
  aliases, function wrappers, subqueries and both arms of a `UNION` are walked;
  a shape the walk cannot classify is refused rather than passed. A profile
  cannot add or relax the field, and a dialect whose AST this walk cannot
  traverse refuses to boot instead of quietly enforcing nothing.

  This is not a claim that masked values in general became unlearnable. It
  applies to listed columns, and counting channels (`COUNT`, `EXISTS`, repeated
  probing) remain — LIMITATIONS says so in both languages.

- **Behaviour is byte-identical without the field.** A config that does not set
  `protectedColumns` runs exactly as 0.2.19 did; a test locks that.

## 0.2.19 — 2026-08-16

- **Listable in the official MCP Registry.** `package.json` carries `mcpName`
  and the repository ships a `server.json`, the two files the registry checks
  against each other before it will accept a server. Directories that used to
  take submissions by hand now read from that registry, so this is the entry
  the ecosystem actually looks at.

- **A signature must be canonical base64.** Node's decoder is lenient: it
  accepted a URL-safe alphabet and a dropped `=`, so a signature could be
  rewritten and still verify. Every signature check — the library and both
  shipped verifiers — now re-encodes the decoded bytes and refuses anything
  that does not round-trip. Exit codes are unchanged.

- **Invariants under random input.** Masking, the row cap, JCS key ordering and
  tamper detection each hold over a thousand generated cases per run, and four
  fuzz targets (SQL gate, receipt JSONL, JCS, countersignature) run in CI.

- **A second, independent verifier.** `verifiers/go` checks a receipt chain
  using only the Go standard library, with no code shared with the TypeScript
  implementation; CI runs every conformance vector through both and compares
  exit codes. It is not part of the npm package.

## 0.2.18 — 2026-08-15

- **LIMITATIONS catches up with reality.** The published package still said
  "Conarium does not run a countersigning service yet" — false since the
  endpoint went live at `demo.conarium.dev/anchor`. The section now states what
  actually holds: one key on one server, no HSM, and an encrypted off-site
  escrow that lets the keyId survive losing the machine but does nothing
  against theft. This release also ships two sections written after 0.2.17 was
  published: masking hides values, it does not make them unlearnable, and the
  row cap is per query, not per session.

- **A release tags itself.** Every git tag so far was pushed by hand after the
  fact, which is exactly the kind of step that gets skipped once. `publish.yml`
  now pushes `v<version>` after a successful publish and leaves no tag behind a
  failed one.

## 0.2.17 — 2026-08-15

- **`GET /anchor` describes the service.** The path only accepted POST, so the
  address a visitor types first answered with Express's default `Cannot GET
  /anchor` under `<title>Error</title>`. Every other surface in this product
  explains itself; the front door of the countersigning service was the one that
  looked broken. It now returns, in JSON or HTML, who signs, where the public key
  and log head are, how to submit, the exact verify command — and the three
  sentences about what a countersignature does **not** say. The test asserts the
  index carries nothing that was not already public.

## 0.2.16 — 2026-08-15

Countersigning: a second party on your chain head, and a revocation fix that
turned up while building it.

- **The anchoring endpoint countersigns.** Every accepted submission is signed
  with the service's own Ed25519 key, so the record carries a signature from
  someone other than the party that produced the chain. Relaying a hash to a
  public timestamp calendar was never worth paying for — the customer can do
  that themselves, for free, and now the code says which of the two is the
  point. The service refuses to start without a signing key, and refuses a key
  file other users can read.

- **The log is an append-only hash chain.** Records carry `seq`, `prevHash` and
  their own entry hash, and a pending anchor that later confirms is appended as
  a new row instead of rewriting the old one. The file previously carried a
  comment promising append-only next to a function that rewrote the whole thing.
  A tampered log now fails the chain check instead of being served.

- **Inclusion proofs and an offline verifier.** `GET /anchor/:id` returns the
  path from a record to the log head, and `conarium-countersign-verify` checks a
  countersignature with zero imports from this package. "Could not check the
  log" (15) stays distinct from "the proof is false" (14).

- **The timestamp covers the log head, not each submission.** N submissions cost
  one calendar request instead of N, and a slow calendar can no longer delay
  accepting a submission — stamping is off the request path entirely.

- **Public records name one thing per word.** The submitted value is `digest`
  and the record's own link is `chainHash`. Both used to be reachable as `hash`
  in a single document, next to a `prevHash` that chains only one of them.

- **Token revocation could be silently ignored.** The token store reloaded only
  when the file's mtime changed, and mtime resolution is filesystem dependent —
  so a revocation written inside the same tick as an earlier edit never took
  effect, and the revoked token kept resolving to its user. Staleness is now
  decided by the file's content. This had been showing up as an intermittently
  failing test and was read as flakiness rather than as the bug it was.

## 0.2.15 — 2026-08-15

A rendering fix that only shows up when something else has gone wrong.

- **The unanchored notice is rendered in Turkish.** `/proof` says, when the
  chain head carries no timestamp, that the demo is not anchored. The English
  sentence had no entry in the presentation dictionary, so a Turkish page
  printed one English line — and it printed it precisely when stamping had
  failed, which is the moment the page should look most deliberate rather than
  least. Nothing about the claim changed; only the language it appears in.

- **A click on the receipts tab must fill the table on the first click.** The
  panel had been reported as filling only on the second click. The path was
  already correct; this release pins it with a test that drives the real
  `app.js` click handler, so the report cannot come back unnoticed.

## 0.2.14 — 2026-08-15

Follow-up to the 0.2.13 hardening: the detector rule that 0.2.13 half-fixed,
plus the findings CodeQL raised on the new code.

- **Behavior change:** what a digit run proves now decides whether letters
  around it can hide it, instead of how long the tail is. A Luhn card, a
  checksum-valid TCKN and a TR mobile number are masked under any letter tail
  (`4111…xyz`, `0532…xyz`). A run that is merely ten or eleven digits keeps the
  bounded rule, because relaxing that one would mask the digits inside a token
  and leave `ghp_[MASKED_PII]abcd` where the secret detector can no longer
  recognise it. Vector values that fail the TCKN checksum on purpose are
  unchanged.

- **Launcher paths are quoted for sh.** The macOS launcher wrapped both paths
  in double quotes and escaped only `"`, so `$(…)`, backticks and `\` in a path
  this code does not choose stayed live shell. Single quotes with the `'\''`
  idiom make a path a path.

- **The audit sink lock is 0600.** It was written with the default mode, next
  to data that is not world-readable. `wx` already refused a planted symlink.

- **CodeQL scope excludes tests** (`.github/codeql/codeql-config.yml`). A ReDoS
  pattern the loader must reject and a hostile URL the verifier must refuse are
  fixtures, not defects; reporting them buried the product findings. `src/` and
  `api/` are unchanged in scope.

- **Docs:** `examples/proof-service/` said the `/proof` service existed only on
  the box and invited someone to copy it here. Its sources are versioned in the
  site repo; the page now records the one thing that matters to this package —
  the service resolves the receipt view from `CONARIUM_ROOT` but keeps its own
  copies of `governance.js` and `audit-hash.js`, so a masking or audit-hash
  change does not reach `/proof` until those are recopied and it restarts.

- **Behavior change (A1):** A single trailing letter no longer hides a
  card or TR phone (`4111…x`, `0532…x`). A longer alphanumeric tail
  (`ghp_1234…abcd`) stays a token so the secret detector still fires.

- **A2:** Dev-only `vitest` 2.1.9 → 4.1.10 (closes the vite/esbuild
  Dependabot chain). Production dependencies unchanged.

- **A3:** `LAST-RUN.json` no longer carries a `when` timestamp, so a
  green generator run does not dirty the tree.

- **A4:** `examples/proof-service/README.md` is the repo seat for the
  box-only `/proof` process. `.gitignore` now covers `*.bak-*`.

## 0.2.13 — 2026-08-15

Security hardening release. Two independent external reviews and one code
audit produced the findings below; each was reproduced against running code
before it was fixed. Several defaults change — the entries marked
**Behavior change** are the ones to read before upgrading.

- **Dialect scalar functions.** The function allow-list carries Postgres
  names, so routing the MSSQL and Oracle gates through it denied ordinary
  calls (`GETDATE`, `ISNULL`, `DATEADD`, `NVL`, `TO_CHAR`). Safe scalars are
  now listed per dialect and consulted only for an unqualified name, so
  `app.pkg.nvl` stays a user package. One dialect's list never applies to
  another's gate, and row-collapsing, `DBMS_*` and `UTL_*` families remain
  denied.

- **npm Trusted Publishing (OIDC).** The publish workflow no longer expects a
  long-lived `NPM_TOKEN`; npmjs.com recognises the repository and workflow as
  the authorised publisher and provenance is attached to the release. No
  publish token lives in the repository. See `docs/security/NPM-PROVENANCE.md`.

- **G20:** Write-token scan ignores SQL string literals
  (`SELECT 'DELETE ' FROM t` is a read). OpenAPI fetch caps the body at
  50KB before `JSON.parse`. Audit sink hash stays `JSON.stringify`
  (JCS would break existing files — LIMITATIONS).

- **G12:** `conarium-doctor` warns when HTTP is on and
  `CONARIUM_MCP_RATE_PER_MIN` is 0; a positive limit is an info line.
  The default remains 0 (production profile fills 60).

- **G11:** Unpinned `conarium-verify` still exits 0, but stderr says the
  tail was not seen and `--json` carries `tailPinned`. `--strict` requires
  a tail pin (exit 11) and pins seq from 1. The console verify command
  embeds `--expect-count` and `--expect-last-hash` for the current chain.

- **Behavior change (G10):** OpenAPI fetch uses `redirect: manual` and
  re-checks every hop (max 5). The approved DNS address is pinned via
  an undici Agent lookup; TLS SNI stays the original hostname. undici
  is not added to package.json.

- **Behavior change (G9):** Private key files that are not 0600 fail
  boot. Escape hatch `CONARIUM_ALLOW_LOOSE_KEY_PERMS=1` restores the
  old warning. win32 skips the check (POSIX mode is meaningless).

- **Behavior change (G6):** HTTP sessions idle out after
  `CONARIUM_SESSION_IDLE_MS` (default 30 minutes; 0 = off). Owner-binding
  is unchanged. Sweeper uses `unref()`.

- **Behavior change (G7):** `CONARIUM_MAX_SESSIONS` defaults to 100
  (0 = unlimited). A new initialize at the cap is JSON-RPC rejected.

- **G8:** Token file reloads on mtime change. Broken JSON keeps the
  previous store and logs; it does not fall back to an empty map.

- **G5:** Audit sink takes an advisory `<sink>.lock` (`wx`, PID + start).
  A second OS process is rejected; a stale lock (dead PID) is stolen.
  Same-process re-entry stays allowed (console / validateChain boot).
  The lock does not stop a writer outside Conarium.

- **G4:** `profile: "production"` (or `CONARIUM_PROFILE=production`) refuses
  boot without Ed25519 AND HMAC, turns G3 strict signatures and OpenTimestamps
  anchoring on, and defaults HTTP rate-limit to 60/min unless explicitly 0.
  `conarium-doctor` reports the profile as one block.

- **Behavior change (G21):** `conarium-coverage --receipts` re-verifies each
  receipt Ed25519 signature; a broken sig is not COMPLETE and names the
  receipt. The declaration carries `windowStartPinned` — an unpinned
  prefix-truncated window is no longer a silent complete. Output says
  "access NOT RECORDED", never "no access occurred". `--expect-seq-from`
  pins the window start.

- **Behavior change (G17):** Receipt HTML never prints raw `anchor.state`
  as a trust signal — forged `state: bitcoin` renders as `doğrulanmadı`
  until the OTS sidecar verifies. `--anchor-check` skips `anchor:null`
  (periodic anchoring) and fails only on a claimed-but-unverified
  anchor; the run ends with `N/M anchored, head anchored: yes/no`.
  `--require-head-anchor` exits 14 when the chain head is unanchored.

- **G3:** `CONARIUM_AUDIT_REQUIRE_SIG=1` is opt-in strict boot — any
  unsigned line is rejected when a signing key is configured. Default
  unchanged (legacy unsigned chains still open).

- **Behavior change (G18):** Flat query rows apply the same column-name
  secret/PII heuristic as nested JSON (`api_key` / `password` →
  `[MASKED_SECRET]`). One function, two call sites.

- **Behavior change (G19):** Console `/api/config` redacts `key`,
  `anonKey`, `headers`, and `authorization`, and also redacts JWT /
  `sk-` / `AKIA` shaped values under innocent names.

- **Behavior change (G16):** Audit `reason`, `target`, and `governance`
  go through the same mask pipeline as `args`. A DB error that carries
  a cell value can no longer land unmasked on the signed sink.

- **Audit chain atomicity (G1):** `lastHash` and `sinkSize` advance
  only after a successful sink append — same order as `writeReceipt()`.
  A failed write no longer orphans the in-memory chain.

- **Audit self-heal (G2):** After a failed append, the next successful
  `log()` chains from the last hash that is actually on disk. A fresh
  `Audit({sink})` boot `validateChain` stays clean. `failClosed=true`
  also leaves state unmoved.

- **Behavior change (G15):** Content detectors treat `.` / `/` as group
  separators and use token boundaries (a glued letter or `_` no longer
  hides a card/phone/IBAN). Zero-padded `&#064;` emails are masked.
  Hyphenated US SSN is masked; bare 9-digit SSN stays a documented
  limitation.

- **Behavior change (G14):** MSSQL and Oracle gates use the same function
  allow-list as Postgres (`isSafeBuiltinFunction` / `isBlockedDumpFunction`).
  `STRING_AGG` / `LISTAGG` and user/package functions are denied. MSSQL
  locking hints (`WITH (UPDLOCK)` and kin) are denied. Oracle row-cap
  wrapper strips comments so a trailing `--` cannot swallow `FETCH FIRST`.

- **Behavior change (G13):** Connector/DB error text is masked before it
  reaches the model. Failed `query` / `search` / `describe_table` paths
  that previously skipped the audit trail now write a `denied` line.
  Already-logged denies (policy, missing table, 50KB) are not written twice.

## 0.2.8 – 0.2.12 — 2026-08-14

These shipped across 0.2.8, 0.2.9, 0.2.10, 0.2.11 and 0.2.12 and were kept in
one list at the time; the tags are the authority on which release carries which.

- **Table existence oracle closed.** Assistant `describe_table` / `search` /
  `query` errors no longer distinguish denied from missing. The audit log
  keeps the real reason. Denied tables still never reach the connector.
  `describe_table` now has the same 50KB payload cap as `query` / `search`.
- **Dropped `js-yaml` and `node-fetch`.** Zero remaining imports. HTTP uses
  Node's built-in `fetch` (engines already `>=18`).
- **npm provenance workflow** prepared (`publish.yml`, dispatch-only). Does
  not publish on push. See `docs/security/NPM-PROVENANCE.md`.
- **Two-process audit sink** stated in LIMITATIONS and the threat model.
  No lock in this release.

- **Operator is inside the boundary.** Threat model and LIMITATIONS state
  it in the open: importing the library can skip the gate the same way
  opening the database with the operator's credential can. Not a vulnerability.
- **HMAC compare uses `timingSafeEqual`.** Audit-sink HMAC was `!==` on the
  hex digest. Ed25519 verify stays on Node `crypto.verify`.
- **Doctor names `custom-sql`** and fails when that connector is present
  without a declared `policy.dialect`. `list_tables` on an executor-only
  install says schema discovery is not implemented (not a silent empty list).

- **Operator SQL executor (`custom-sql`).** No MSSQL/Oracle driver is
  shipped. The operator registers a function or a local `config.module`;
  it receives only gated SQL. `policy.dialect` is required on that path.
  Row cap and masking still apply on the return. See
  `examples/custom-sql/`.

- **Postgres overhead measured.** Same SELECT, default `maxRows` 100: about
  5 ms added when email is masked. 500 → ~87 ms. 5 000 → ~22 s. Cost
  follows distinct masked values. Doctor and boot warn above 100; they
  do not reject the query. See `docs/BENCHMARK.md`.
- **Carry-over corpus lock.** `src/governance.carryover-diff.test.ts`.
  A single-pass rewrite disagreed on sequential longest-first overlap
  and was reverted.

- **Overhead benchmark script.** `scripts/benchmark-overhead.mjs` measures
  the same SELECT direct vs through the gate (p50/p95/p99). Without a DSN
  the comparison is recorded as koşulamadı — no invented numbers.
  See `docs/BENCHMARK.md`.
- **Generated SQL-gate attacks.** `test/property_sql_gate.mjs` (property +
  fuzz). A real bypass stays red and is written under
  `test-vectors/sql-gate/`.
- **API stability inventory** (draft, not a 1.0): `docs/API-STABILITY.md`.

- **Built-in OpenTimestamps client.** Stamp / upgrade / verify no longer
  load `javascript-opentimestamps`. The `web3` / `request` / `bitcore` tree
  is not installed. Old proofs still verify (pending fixture + dogfood
  block 960327).
- **Threat model and pentest scope** in `docs/security/`.

- **LIMITATIONS.md** (and `LIMITATIONS.tr.md`) lists what this repository has
  not done. README links it in the body, not a footnote. Comparison stays on
  the site only.
- **`test:checks` runs every check even if one fails.** The old `&&` chain
  went silent after the first failure. `test/init.mjs` resolves temp paths
  with `fs.realpathSync` (`/var` vs `/private/var` on macOS).

- **c1 launcher sets `CONARIUM_AUDIT_SIGNING_KEY`** from
  `~/.conarium/audit-ed25519.pem` when `receiptSink` is set. Cursor MCP env
  did not; the process could not boot receipts. The sink file is still not
  invented empty.
- **Desktop / panel mark.** `assets/conarium-mark.svg` (extracted, not
  redesigned) plus `.ico` / `.icns` / 512 PNG. Shortcuts set Icon; missing
  file warns. Panel CSS gradient square is gone.
- **`/proof` HTML shows known English sentences in Turkish.** The JSON
  bytes are unchanged; unknown strings are left as-is.
- **Makbuzlar tab paints "Yükleniyor…" on the same click that switches the tab.**
  The list was filled only after `await`; the first click left a blank card.
- **Console Makbuzlar tab.** Lists `audit.receiptSink` newest-first, opens the
  same receipt HTML as `/proof`, and writes **zincir sağlam** / **kırık (satır N)**.
  Renderer is `src/receipt-view.ts` — demo must not keep a second copy.
- **`conarium-console --install-shortcut` / `--uninstall-shortcut`.**
  Desktop / Applications / XDG launcher for the existing loopback console.
  Double-click waits until the port listens, then opens the browser with a
  one-time `/handoff` nonce (≤30s). The long-lived token is not put in the
  URL. Auth and CSRF are unchanged for Bearer clients.
- **HTTP gateway returns 404 (plain text) for `/.well-known/*`.** Public
  demo has no OAuth. A 302+HTML catch-all made MCP clients treat the
  redirect body as authorization-server metadata. Caddy must still 404
  these paths before its catch-all; this is defense in depth.

## 0.2.7 — 2026-08-14

CodeQL #16 was real. `mint-token.mjs` wrote the per-user token file at
the process umask (usually 0644) and only then `chmod 0600`. The window
is the product's identity store. The file is now born with `mode: 0o600`;
`chmod` remains a backstop for an already-wide file. The same birth
permission is applied to `writeKeyPairFiles` (private PEM) and
`conarium-init`'s signing key.

Console config saves go through a same-directory temp file + `rename`
so a crash cannot leave a half-written policy.

### Fixed

- **Token / signing-key files no longer exist world-readable, even briefly.**
- **Console `POST /api/config` is an atomic replace.**

**Not published. Not deployed to Hetzner.**

## 0.2.6 — 2026-08-14

Detector coverage plus two operator knobs. Address and bare-name *content*
detectors were not added: both need a dictionary or a model, which this
product refuses. Those gaps stay documented. `conarium-suggest-policy`
guesses `maskColumns` from column names and does not write config.

### Added

- **`policy.scanCharCap`** (default 16 384) and env `CONARIUM_SCAN_CHAR_CAP`.
  Oversize fields are still replaced whole with `[MASKED_PII]`; they are
  never skipped. Raising the cap grows scan cost quadratically. Ceiling
  1 048 576.
- **`policy.detectors`**: `ip` (default **false**), `mrz` (default **true**).
  TCKN / card / IBAN / email are not keys; a config that tries to disable
  them is rejected at load.
- **IPv4 / IPv6** when `detectors.ip` is true. Octets 0–255, no leading
  zeros. `1.2.3.4` is structurally IPv4 and is masked; dates and amounts
  are not. Loopback and private ranges are masked too — leave `ip` off
  if SOC needs them in the clear.
- **Passport MRZ (TD3)** — 2×44, 7-3-1 check digits. Checksum miss → not
  an MRZ. TD1/TD2 not implemented.
- **JSON `\u0040` and `%40`** join HTML `&#64;` as scan-only encoded `@`.
  Non-email encodings are left unchanged. `&amp;#64;` is not chased.
- **Split TCKN** on similarly named fields of the same row when the
  concatenation checksums. No combinatorial scan.
- **`conarium-suggest-policy`** — `--sql` / `--json`. Prints a guess.
  Refuses `--write`.

**Not published. Not deployed to Hetzner.**

## 0.2.5 — 2026-08-14

0.2.4 said a partial mask could no longer count as masked. On the card
path it still could: `4111111111111111` became `411[MASKED_PII]` with
`maskedCount: 1`. Same class as the second-IBAN bug closed in 0.2.2 —
a detector matching from the middle of a longer run.

### Fixed

- **Numeric detectors no longer start inside a longer digit run.** Phone
  had no leading boundary, so it ate 13 digits out of a 16-digit PAN and
  left the prefix. A maximal run is now classified as a whole: 13–16
  digits and Luhn-valid → card, fully masked; 11-digit TCKN-shaped →
  masked; longer runs (20-digit order numbers) are not cards and are
  left alone. `maskedCount` cannot claim a half-masked field.
- **TR national phone (`0` + 10 digits) was dropped while rewriting that
  classifier, then restored.** `0532…` / `0232…` are 11 digits starting
  with `0` — between "10-digit phone" and "11-digit TCKN starting 1–9".
  0.2.4 masked them; the 0.2.5 candidate did not. Classification is
  still on the maximal run (no mid-run prefix). Leading `0` is the
  trunk prefix, not a 2nd-digit numbering-plan check: TCKN never starts
  with `0`; 08xx would miss a 5-vs-2/3/4 split. Compact 10-digit and
  `+90…` formatted numbers were already covered.
- **Content scanner O(n²) on long alphanumeric fields.** Profiled, not
  guessed. Three quadratics: (1) email `local+@` with no `@` (~1 s on
  40k digits); (2) this cut's own backstop, `collapsePartialMask`
  `[A-Za-z0-9]+\[MASKED_PII\]`, backtracking when the literal is absent
  (~50 ms on 12k digits); (3) concatenating a long digit run one char
  at a time, then decoding it as unbounded whole-field base64.
  Local/domain lengths are bounded; `@` absent → skip; collapse skips
  when the mask token is absent; digit runs are counted then sliced
  once; whole-field base64 decode is capped at 256 characters. TCKN
  **checksum is not added** — existing vectors use `12345678901`
  (checksum fails); the hole was mid-run matching, not a missing checksum.

### Behavior

- **A field longer than 16 384 characters is replaced whole with
  `[MASKED_PII]`, including text that contains no identifier.** The scan
  is not skipped. Skipping would let a 20 KB note or JSON column past
  the detectors. `maskedCount` is 1. Fields at or under the cap are
  scanned as before.

### Added

- **HTML `&#64;` / `&#x40;` / `&commat;` emails** are masked when they
  decode to an existing email detector hit. A non-email `&#64;` is left
  unchanged. JSON `\u0040` is still out.
- **PII regression matrix** (`test/pii_regression_matrix.mjs`): one
  canonical example per class (TR phone, TCKN, card, IBAN, email,
  encoding evasions, labelled name) plus the things that must not be
  touched. A dropped class turns the test red.

**Not published. Not deployed to Hetzner.**

## 0.2.4 — 2026-08-13

Two things 0.2.3 said it did, and did not. Found by attacking the published
tarball, not by reading the docs.

### Fixed

- **`conarium-verify` could not see receipts deleted from the end of the
  file.** A leftover prefix of a valid chain is still internally consistent, so
  exit 0. Middle deletion was already exit 11. `SECURITY.md` said the verifier
  detected "truncation"; `README.md` said receipts proved records had not been
  "deleted". Both claims are narrowed: the hash chain is structurally blind to
  a shorter tail. Catching that needs a pin from outside the file.
- **Zero-width / look-alike characters split identifiers so the IBAN scanner
  never fired**, then the digit scanner ate the tail and left
  `TR33<ZWSP>000610051[MASKED_PII]` with `maskedCount: 1` — the audit record
  claiming more protection than the model actually got. The scanner now
  strips ZWSP/ZWNJ/ZWJ/BOM/soft hyphen and maps fullwidth digits / `＠` /
  unicode dashes to ASCII *before* the detectors. A leftover country-code
  prefix glued to a mask is collapsed so a partial mask cannot count as
  masked. **The outgoing string is the normalised form even when nothing was
  PII** — that is a conscious output change, not a silent one.
- **Wrapped base64 / hex tokens inside a field** (`encoded: cGF0cm9u…`) were
  not decoded. Whole-field base64 already was. In-field tokens are now masked
  only when they decode to an existing detector hit; hashes and non-PII
  payloads are left alone.
- **Supabase REST `SELECT col AS alias` / PostgREST `col:alias`** skipped
  column-name policy (`maskedFields` is empty on that path; a renamed key
  does not match `customer_name`). Aliases are rejected with a reason.

### Added

- **Opt-in tail pins** `--expect-count N` and `--expect-last-hash sha256:…`.
  A miss is exit **11** (same code as a `prevHash` break). Default
  `conarium-verify <file>` is unchanged: a truncated tail still exits 0.
  Empty-chain stderr now says that exit 0 is not a verification that nothing
  was deleted. No new exit code. Schema string `conarium-receipt/0.3`
  unchanged.

**Not published. Not deployed to Hetzner.**

## 0.2.3 — 2026-08-13

The published 0.2.2 tarball rejected the `policy.profiles` config its own
README documented. Same class of defect as 0.2.2 itself (the README said IBAN;
the tarball did not).

### Fixed

- **`loadConfig()` rejected `policy.profiles` / `policy.actorProfiles`.**
  `GovernancePolicySchema` was `.strict()` and those keys were not on it, so a
  config copied from the README's "Per-person masking profiles" example threw
  `Unrecognized key` and the gateway would not boot. The class honoured the
  fields when constructed by hand; the loader did not. The schema now keeps
  `profiles`, `actorProfiles` and `maskLabelledNames`. A profile may still
  carry only `maskColumns`, `maxRows` and `maskLabelledNames`; an
  `allowTables` key on a profile is still rejected — a profile cannot widen
  reach.
- **`types.ts` JSDoc said an empty allow-list meant "allow all".** The code has
  been default-deny since 2026-07-06. The comments now match: missing or empty
  `allowTables` / `allowConnectors` denies everything.
- **Stale receipt wording.** README labelled receipts `(v0.1)` while the
  schema string is `conarium-receipt/0.3`. RECEIPT-SPEC said a block-explorer
  network error was exit 14; calendar unreachability is already exit 15, and
  this repository has no separate explorer client. Exit codes were not
  changed.

### Added

- **The remote HTTP gateway is started as a real process in CI**
  (`test/http_gateway.e2e.mjs`). The session-owner unit test still calls the
  handler with a fake `req`. The new test binds port 0, speaks Streamable HTTP
  over `fetch`, parses SSE as frames, and locks the restart regression
  (unknown `Mcp-Session-Id` → 404 + JSON-RPC `-32004`, not 400 +
  `text/plain`). Happy path: initialize → session → `tools/list` → masked
  `tools/call` → receipt file 0→1 → `conarium-verify` exit 0. Error bodies
  for 401 / 403 / 404 / 429 / 400 / 500 are asserted `application/json`.
  **Not deployed to Hetzner.** The test file is not in the npm tarball
  (`test/` is outside the `files` allowlist).

## 0.2.2 — 2026-08-13

An identifier the column policy could not catch, and two things that were true
in git but not in the tarball.

### Added

- **IBAN content detector.** `maskColumns: ['*.iban']` only fired when the
  column was named. Free text, and columns the operator forgot to list, sent
  the IBAN to the model — sometimes half-masked by the digit detector, which
  looks like protection. The scanner is deterministic (ISO 7064 mod-97-10);
  a profile cannot switch it off. Street addresses, IPs and passport numbers
  are still not detected. **Not deployed to Hetzner.**
- **Per-user identity local pack** (`examples/per-user-identity/`). Token
  mint (hash on disk), c2 policy overlay, same-row proof for two actors,
  rollback. Does not touch the live box.
- **Hetzner process scripts** copied into `deploy/hetzner/` (sanitized,
  reconstructed — live files were not pulled). Excluded from the npm tarball.
- **Receipt spec** aligned to canonical schema `conarium-receipt/0.3`; media
  type `application/vnd.conarium.receipt+json` documented. Schema string
  unchanged.

### Fixed

- **Only the first IBAN in a field was masked; the second passed through in
  full.** Caught while reviewing the detector above, before it shipped. One
  greedy candidate regex treated the separator between two IBANs as part of a
  single match ("ve" is alphanumeric), then the length cap cut that match in the
  middle of the second IBAN — and `String.replace` resumes after the match, so
  the remainder never matched anything again. `IBAN1 ve IBAN2` produced one mask
  and one untouched IBAN. "From account X to account Y" is an ordinary sentence
  in payments, not an edge case. The scanner is now anchor-driven: find an
  anchor, take the longest IBAN-shaped run, shrink until the checksum holds, and
  resume scanning immediately after the part that was consumed.
- **`examples/per-user-identity/conarium.tokens.json` entered the npm tarball.**
  It is listed in `.gitignore`, so git looked clean — but a `files` allowlist
  overrides `.gitignore`, which is the same mechanism that shipped a private key
  in 0.2.0. That is three instances of one class in a day, so the fix is no
  longer another pattern: `test/pack_artefakt.mjs` now holds the exact list of
  files allowed to ship from `examples/`, and anything generated fails the test
  by default. Adding an example is a deliberate edit to that list.

## 0.2.1 — 2026-08-13

Two silent failures: a first run that told you to run a command that fails, and
a gateway that stopped governing without saying so.

### Fixed

- **The published tarball contained a private key, and the README in the same
  tarball said it did not.** `test-vectors/keys/vector-key.SECRET-TEST-ONLY.pem`
  is a throwaway Ed25519 key with no authority over anything — it signs the
  conformance vectors and nothing else. Git excludes it; npm did not, because a
  `files` allowlist overrides `.gitignore`. So 0.2.0 shipped a `BEGIN PRIVATE
  KEY` while `test-vectors/README.md` promised the private half is never
  published. The security impact is nil and the honesty impact is not: verify
  what you ship, not what you meant to ship. The package now excludes every
  `*.pem` that is not a `*.pub.pem`, and a test asserts it on the real
  `npm pack` output.

- **`conarium-init --out <dir>` printed a next step that fails.** The config
  goes to `<dir>`, but the printed command was `conarium-doctor --no-net`, and
  the doctor looks in the working directory. First run ended in a red FAIL.
  Both the printed command and the MCP client block now carry `--config <path>`.
- **The MCP client block started an ungoverned gateway.** It emitted
  `args: [dist/index.js]` with no config path. An MCP client starts the server
  in *its own* working directory, not your install directory; with no config
  found, the gateway does not fail — it comes up with zero connectors and
  governs nothing, quietly. This was true with or without `--out`.
- **A restarted remote gateway lost its client permanently.** A client
  returning with a session id from before the restart got
  `400 expected initialize` as `text/plain`. MCP clients expect JSON-RPC, so the
  reason never reached the user — one proxy reported only "Invalid content from
  server". An unknown session is now `404` with a JSON-RPC body telling the
  client to send a new initialize, and every error response
  (401/403/404/429/400/500) is `application/json`. A plain-text error is an
  undiagnosable error.

## 0.2.0 — 2026-08-13

The governance console was in the package and unreachable. Now it starts.

### Added

- **`conarium-console`** — starts the console over the policy file. It binds
  `127.0.0.1`, refuses to run without `CONARIUM_CONSOLE_TOKEN`, and refuses a
  non-loopback bind unless `CONARIUM_CONSOLE_PUBLIC=1` says you meant it. A
  policy editor reachable from the network is a different threat model than a
  policy editor on your own machine, and the difference should be a decision,
  not a default.

### Fixed

- **The console shipped but nothing could start it.** No bin entry, and the
  gateway never launched it. It has been listed on the pricing page since the
  tiers were written; installed users had exactly one way to change what gets
  masked — editing `conarium.config.json` by hand.
- **It edited the wrong file.** `startConsole()` defaults to the config bundled
  inside the package, which for an installed user is wrong twice: it is not the
  file the gateway reads, and `npm i` overwrites it. The command now defaults to
  `conarium.config.json` in the working directory — the same file the gateway
  loads — and takes `--config`.
- **The UI did not ship.** `public/` was missing from the `files` allowlist, so
  the installed package served `404` at `/`. That was an omission in the 0.1.0
  packaging change.

### Known limits — read before believing the pricing page

The console today edits **`allowTools`, `denyTools` and `maxRows`**. It does
**not** edit `maskColumns`, `allowTables` or `denyTables`, and it has no UI for
per-consumer profiles. Those remain hand-edited in `conarium.config.json`. The
column and table rules are the ones that decide what an assistant can see, so
this is the gap that matters; it is named here rather than left for a buyer to
discover.

## 0.1.2 — 2026-08-13

Patch. `conarium-doctor` aborted instead of exiting when a connector was
unreachable.

### Fixed

- **The documented exit contract (`0` clean / `1` problems / `2` could not run)
  was not honoured on the network path.** The TCP probe resolved on the socket's
  `error` event and the process then exited while the handle was still closing;
  on Windows libuv asserted (`UV_HANDLE_CLOSING`) and the run ended with **127**
  — a code this tool does not define, printed under an assertion trace. Anything
  gating a deployment on the exit status could not read it. Reproduced 3/3 with
  a refused connection; `--no-net` was never affected.

  The probe now resolves after the socket has actually closed, and the tool sets
  `process.exitCode` instead of calling `process.exit()`, so the loop drains on
  its own. A regression test pins it: an unreachable connector must exit `1` and
  the output must not contain an assertion.

## 0.1.1 — 2026-08-13

Patch. The shipped MCP examples told you to run a command that cannot run.

### Fixed

- **`examples/cursor-mcp-settings.json` and `examples/claude-desktop-config.json`
  proposed `npx -y @conarium-ai/core`, which fails with `could not determine
  executable to run`.** The package ships eight commands and none of them is
  named `core`, so npx has nothing to pick. Anyone who pasted the example into
  Cursor or Claude Desktop hit a wall on their first attempt — the worst possible
  moment. The working form, measured rather than assumed:

  ```json
  { "command": "npx",
    "args": ["-y", "--package=@conarium-ai/core", "conarium",
             "--config", "/path/to/your/conarium.config.json"] }
  ```

- The README MCP client block said `"command": "node", "args": ["dist/index.js"]`
  — the from-source path, wrong for anyone who installed the package.

### Changed

- README Quick Start leads with the npm install path now that the package is
  published; the from-source route is kept, folded into a `<details>`.

## 0.1.0 — 2026-08-13

First product cut, published to npm as `@conarium-ai/core@0.1.0`.

### Fixed before it shipped — `bin` entries were being stripped

The first publish attempt failed on 2FA, and the failure was lucky. Its output
carried this, once per command:

```
npm warn publish "bin[conarium-doctor]" ... was invalid and removed
```

npm was dropping **all eight** command entries, because the values began with
`./`. Published that way, `npx conarium-doctor` would not have existed — the
whole point of a one-download install. `npm pack` was never affected, so the
tarball looked correct the entire time; what npm rewrote was the metadata sent
to the registry. Fixed with npm's own `npm pkg fix` (`./bin/x.mjs` → `bin/x.mjs`)
and verified against the published package: eight bins present.

**Lesson worth keeping: a correct `npm pack` does not mean a correct
`npm publish`. Read the `warn` lines in `npm publish --dry-run`.**

### Added — install without us in the loop

- `conarium-init` (`bin/conarium-init.mjs`): writes a fail-closed
  `conarium.config.json`, an Ed25519 key pair, and the `.keyid` sidecars the
  verifier needs. Refuses to overwrite without `--force`. Never prints the
  private key. Exit 0/1/2 (outside the receipt exit-code namespace).
- `conarium-doctor` version section: prints the installed version from
  `package.json`. With a network, GETs `registry.npmjs.org/@conarium-ai/core/latest`
  (2s timeout, errors are warnings). `--no-net` makes **zero** requests.
  Telemetry none — the request is a version number, nothing is sent.
- Offline license verifier (`src/license.ts`): JCS + Ed25519, same construction
  as receipts. Missing/invalid/expired → `community`. No feature gates, no
  keygen, no payments.
- `package.json` `files` allowlist: the tarball is `dist`, `bin`, `scripts`,
  `docs`, `examples`, `test-vectors`, `deploy`, plus the license/readme files —
  not CI workflows or the marketing site. `scripts/` is included because
  `conarium-reconcile` references `scripts/pg-snapshot.sql`.
- `deploy/anchor-service/`: systemd unit, pm2 ecosystem, `.env.example`, dry-run
  script. **Deploy itself is not this release.**

### Added — conarium-reconcile v0.1: two-sided coverage (bypass detection)

- New standalone CLI `bin/conarium-reconcile.mjs` (zero imports from `src/`):
  reconciles the database's **own per-role query counters** (reference:
  `pg_stat_statements`, snapshot helper `scripts/pg-snapshot.sql`) against the
  in-window receipts. A DB-recorded query pattern no receipt covers exits 40:
  *access was recorded by the database but not receipted* — gateway bypassed or
  receipt sink failed; the tool states the fact, not the intent.
- Honesty rules carried over from the coverage declaration: per-pattern/per-table
  matching (never per call count — PostgREST fans one request into several
  statements), nothing silently cleared (unattributable patterns fail the run),
  unreliable windows refused (counter regression → exit 20), unassigned receipts
  make findings explicitly non-definitive.
- `test/spec_exitcode_drift.mjs` now guards **all three** CLIs
  (verify / coverage / reconcile) against the RECEIPT-SPEC exit-code tables;
  proven to fail in both directions.
- RECEIPT-SPEC known gap #2 updated: bypass detection is now addressed with
  stated limits (DB counters are trusted, dedicated role required).

### Fixed — HMAC signature contiguity (the HMAC half of F1)

- `validateChain` rejected **unsigned legacy entries** as corrupt whenever an HMAC key was
  present: `entry.signature !== expected` was the only check, so a missing signature failed
  it. Any audit sink written before signing existed became unopenable the moment HMAC was
  configured — the server would not boot. This is the same conflation F1 fixed for Ed25519
  in July (*"cannot be verified with this key"* ≠ *"tampered"*), left open on the HMAC side.
  It hit production on 2026-08-05 and forced HMAC to be disabled, which in turn left the
  install exposed to the strip-all attack that HMAC is the documented mitigation for
  (RECEIPT-SPEC known gap #4).
- Now symmetric with Ed25519: unsigned entries **before** the first signed entry are legacy
  and accepted; an unsigned entry **after** a signed one is a signature-removal attempt and
  is rejected; a present-but-wrong signature is always rejected. Signature *presence* counts
  toward contiguity even without a key, so "drop the key, then strip the signatures" fails.

### Changed — Receipt v0.3: meta provenance

- `model` and `client` now carry a `source` field alongside the value:
  `protocol` (measured from MCP `initialize`), `operator-declared` (declared in config,
  **not** verified by Conarium), or `undeclared` (`null` fields — nothing invented).
- **`audit.receiptModel` / `audit.receiptClient` are no longer required.** Previously,
  configuring `receiptSink` without both fields threw at construction, which kept receipt
  generation permanently off: model identity does not exist in the MCP protocol, so it
  could only ever come from an operator's declaration. Receipts are now emitted and the
  missing field is recorded as `undeclared` instead of being invented.
- Verifier accepts `0.1`, `0.2` and `0.3`; older receipts remain verifiable (regression-locked).
  It reports undeclared counts: `ok: 3 receipt(s) verified (2 with undeclared model)`.
- ⚠️ Ed25519 remains **required** for receipts — this was not relaxed.
- Spec: `docs/superpowers/specs/2026-08-05-receipt-meta-provenance-design.md`

### Added — Receipt v0.1 (verifiable audit receipts)

- Ed25519 key management (`src/keys.ts`) with `.keyid` sidecars
- Portable receipt schema + JCS canonicalize + hash (`src/receipt.ts`)
- Independent offline verifier: `bin/conarium-verify.mjs`
- Transparency-log anchor interface + scheduler (`src/anchor.ts`; Memory sink for tests, Rekor-shaped sink stub)
- Spec: `docs/RECEIPT-SPEC.md`

### Changed

- **BREAKING — Connectors are fail-closed.** `policy.allowConnectors` is
  now a strict allow-list: if it is missing or empty, **no** connector is
  permitted (previously an empty list meant "allow all"). This matches the
  existing default-deny posture of `allowTables` — the product's stated position
  is "Nothing is allowed unless you allow it", and the connector path was the one
  exception that contradicted it. `bootDeps` now refuses to start when connectors
  are configured but `allowConnectors` is empty, naming the missing field and the
  connectors it should list — so an operator blames the changed default, not
  their own policy. **Migration:** add `policy.allowConnectors: ["connector1", "connector2"]`
  to your config (or remove the connectors). `denyConnectors` still takes
  precedence over `allowConnectors`.

- Audit signing is **fail-closed**: without `CONARIUM_AUDIT_HMAC_KEY` or
  `CONARIUM_AUDIT_SIGNING_KEY`, writes throw unless `CONARIUM_AUDIT_UNSIGNED=1`
  is set explicitly (was: silent skip). Capability is checked at **construction**
  as well as `log()` (GATE 1 / F3).
- Audit entries may carry Ed25519 `sig` alongside legacy HMAC `signature`.
- `validateChain` treats missing `sig` / foreign `keyId` as out-of-scope (legacy /
  rotation), not tampering (GATE 1 / F1).

### Added — OpenTimestamps anchoring (Katman 0 / A)

- `OpenTimestampsSink` + sidecar `<sink>.anchors.jsonl` (hash-only; opt-in via
  `CONARIUM_ANCHOR_SINK=opentimestamps`)
- `bin/conarium-anchor-upgrade.mjs` (pending → bitcoin)
- `conarium-verify --anchor-check` verifies OTS against chain head (pending warns)
- Rekor explicitly rejected; RFC3161 deferred — see `docs/RECEIPT-SPEC.md` §Anchoring

### Docs (GATE 2)

- Official claim: English is canonical; Turkish kept as translation (G2-1).
- Known gaps §4: in-file sig stripping + HMAC/anchor reduction — *in-file çözülemez* (G2-2).
- `writeKeyPairFiles` now returns `publicKeyIdPath` (G2-3).

### Fixed (GATE 1 follow-up / F5)

- `validateChain` Ed25519 **contiguity**: after the first signed line, missing
  `sig` is corrupt; foreign `keyId` accepted when present in the trust store.
- Multi-keyId trust store: current signing pubkey + `CONARIUM_AUDIT_TRUST_PUBKEYS`.
- See `docs/superpowers/TODO-gate1-f4.md` (F4 text; implemented as F5).
