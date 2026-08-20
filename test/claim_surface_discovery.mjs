/**
 * Which changed files get read as claims, and which fall out of the review.
 *
 * The rule lives in claim_surfaces.mjs. This file pins the decisions it makes,
 * including the one it used to get wrong: `standards/draft-` was excluded by
 * name, on the ground that a posted Internet-Draft is immutable and was
 * reviewed at submission. True of the posted copy, false of the repo one — the
 * file exists in the tree before it is posted, and that window is the only one
 * in which review can still change the text. -04 spent that window carrying
 * four statements about this implementation that were accurate when written
 * and false within days, and nothing named the file.
 *
 * The superseded rule is restored below rather than described, so the
 * regression is visible to whoever reads this next instead of remembered.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentDraft, isUnlistedDoc, SURFACES } from './claim_surfaces.mjs'

const listed = new Set(SURFACES)
const unlisted = (p) => isUnlistedDoc(p, listed)

// ── the case this check exists for ───────────────────────────────────────────
// The rule answers "does this path need a decision", not "what is listed
// today". The list is supplied explicitly here: pinning these two assertions
// to the live surfaces.json would make them pass or fail on an edit that has
// nothing to do with the rule — which is what happened the first time this
// file was written against -05, on the same branch that then listed it.
const UNDECIDED_DRAFT = 'standards/draft-dogru-scitt-disclosure-evidence-06.md'
const nothingListed = new Set()
assert.equal(
  isUnlistedDoc(UNDECIDED_DRAFT, nothingListed),
  true,
  'a draft revision in the tree has to be decided about',
)

const supersededRule = (p) => !/^standards\/draft-/.test(p) && isUnlistedDoc(p, nothingListed)
assert.equal(
  supersededRule(UNDECIDED_DRAFT),
  false,
  'the rule this replaced answered false here — that is the whole reason it changed',
)

// Deciding is what silences it. The current revision is a surface, so the
// auditor stops asking about it; the question was answered, not suppressed.
assert.equal(
  unlisted('standards/draft-dogru-scitt-disclosure-evidence-05.md'),
  false,
  'the current draft revision is read as a surface, not flagged as undecided',
)

// ── the current revision is derived, not listed by hand ──────────────────────
// surfaces.json ships in the package, so naming each revision there costs a
// version bump per revision. version_claim caught exactly that, in CI, on the
// commit that tried it — a list nobody can afford to update is a list that
// goes stale, which is the failure this whole file exists to prevent.
const fixture = mkdtempSync(join(tmpdir(), 'cnr-drafts-'))
for (const f of ['draft-x-03.md', 'draft-x-04.md', 'draft-x-05.md', 'draft-x-05.xml', 'README.md']) {
  writeFileSync(join(fixture, f), '')
}
assert.deepEqual(
  currentDraft(fixture),
  ['standards/draft-x-05.md'],
  'the highest-numbered revision is the surface; the ones before it are posted records',
)
assert.deepEqual(currentDraft(join(fixture, 'no-such')), [], 'a tree with no standards dir yields none')

const live = currentDraft()
assert.equal(live.length, 1, 'exactly one revision is open for editing at a time')
assert.match(live[0], /^standards\/draft-.+-\d{2}\.md$/, 'the derived surface is a draft revision')
assert.ok(SURFACES.includes(live[0]), 'the derived revision is part of the surface list it is derived into')

// ── depth is not the rule ────────────────────────────────────────────────────
// `docs/security/THREAT-MODEL.md` sat in neither list under the depth rule and
// carried a stale sentence into 0.2.35. A new document beside it must surface.
assert.equal(unlisted('docs/security/A-NEW-CLAIM.md'), true, 'depth does not excuse a document')
assert.equal(unlisted('A-NEW-TOP-LEVEL-CLAIM.md'), true, 'a new top-level document surfaces')

// ── already decided ──────────────────────────────────────────────────────────
assert.equal(unlisted('README.md'), false, 'a listed surface is read, not unlisted')
assert.equal(unlisted('standards/README.md'), false, 'a listed surface is read, not unlisted')

// ── named exemptions, with their reasons beside the list ─────────────────────
assert.equal(unlisted('CHANGELOG.md'), false, 'a record of what happened is not a promise')
assert.equal(unlisted('AGENTS.md'), false, 'instructions to a contributor are not a promise')
assert.equal(
  unlisted('docs/claims/reviews/0.2.37.md'),
  false,
  'working records are written to be superseded',
)
assert.equal(
  unlisted('docs/teaching/method-two-ledgers-one-window.md'),
  false,
  'classroom texts are not product promises',
)

// ── not every changed file is prose ──────────────────────────────────────────
assert.equal(unlisted('src/audit.ts'), false, 'code is reviewed as code')
assert.equal(
  unlisted('standards/draft-dogru-scitt-disclosure-evidence-05.xml'),
  false,
  'the xml is generated from the md that was already read',
)

console.log(
  'claim surface discovery: drafts in the tree surface for decision, superseded rule pinned red, depth exemption still gone, named exemptions intact',
)
