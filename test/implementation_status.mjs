#!/usr/bin/env node
/**
 * The Implementation Status section is a claim about this code. Run it.
 *
 * Four sentences in -04 were accurate the day they were written and false within
 * days, every one of them in the direction of claiming less than the tool did.
 * None was found by any mechanism here; they were found by a reader holding the
 * document beside the tool's output. That is the gap this check closes, and the
 * draft says so in its own words: "The implementation's test suite contains no
 * check that compares this section against what the code does."
 *
 * How it works. Three declarations of one fact exist: the code, the claim table
 * in standards/implementation-status-claims.json, and the prose in the draft.
 * The prose cannot be executed, so the table stands between them:
 *
 *   table <-> code    every claim is run against the shipped CLI
 *   table <-> prose   every value the run produced must still appear in the
 *                     bullet that states it, and every bullet must have a claim
 *
 * A bullet with no claim is a sentence nothing measures. A claim with no bullet
 * is a measurement the document dropped. Both are red.
 *
 * The draft it reads is the highest-numbered revision present, derived rather
 * than named here, because a hard-coded revision is the same class of stale
 * declaration this check exists to catch.
 *
 * A red here has two honest fixes: change the code back, or write the revision
 * that says what the code now does. Editing a posted draft is not one of them.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(readFileSync(join(root, 'standards', 'implementation-status-claims.json'), 'utf-8'))
const fixtures = join(root, ...spec.fixtures.split('/'))

// ── which draft ──────────────────────────────────────────────────────────────
const drafts = readdirSync(join(root, 'standards'))
  .filter((n) => /^draft-dogru-scitt-disclosure-evidence-\d+\.md$/.test(n))
  .sort()
assert.ok(drafts.length > 0, 'no draft found in standards/')
const draftName = drafts[drafts.length - 1]
const draft = readFileSync(join(root, 'standards', draftName), 'utf-8')

// ── the bullets that state observed behaviour ────────────────────────────────
const sectionAt = draft.indexOf(`# ${spec.section}`)
assert.ok(sectionAt !== -1, `${draftName} has no "${spec.section}" section`)
const section = draft.slice(sectionAt)
const bulletsAt = section.indexOf(spec.bulletsFollow)
assert.ok(bulletsAt !== -1, `${draftName}: "${spec.bulletsFollow}" is not in ${spec.section}`)

const after = section.slice(bulletsAt + spec.bulletsFollow.length)
const bullets = []
let current = null
for (const line of after.split('\n')) {
  if (line.startsWith('- ')) {
    if (current) bullets.push(current)
    current = line.slice(2)
  } else if (current !== null && line.startsWith('  ')) {
    current += ' ' + line.trim()
  } else if (current !== null && line.trim() === '') {
    continue
  } else if (current !== null) {
    bullets.push(current)
    current = null
    break
  }
}
if (current) bullets.push(current)

assert.equal(
  bullets.length,
  spec.claims.length,
  `${draftName} states ${bullets.length} observed behaviour(s), the claim table runs ${spec.claims.length}.\n` +
    '  A bullet with no claim is a sentence nothing measures.\n' +
    '  A claim with no bullet is a measurement the document dropped.\n',
)

// ── run one claim against the shipped tool ───────────────────────────────────
function reconcile(args) {
  const argv = [
    join(root, 'bin', 'conarium-reconcile.mjs'),
    '--before',
    join(fixtures, 'before.json'),
    '--after',
    join(fixtures, 'after.json'),
    '--receipts',
    join(fixtures, 'receipts.jsonl'),
    '--json-v2',
    ...args.map((a) => (a.endsWith('.json') ? join(fixtures, a) : a)),
  ]
  try {
    return { code: 0, out: execFileSync(process.execPath, argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const failures = []
const record = (id, what) => failures.push(`  ${id}: ${what}`)

for (const [i, claim] of spec.claims.entries()) {
  const bullet = bullets[i]

  // table <-> prose. The run's own words have to survive in the sentence.
  for (const token of claim.tokens) {
    if (!bullet.includes(token)) {
      record(claim.id, `the sentence no longer contains ${token}\n      sentence: ${bullet.slice(0, 160)}`)
    }
  }

  // table <-> code.
  if (claim.runs) {
    for (const r of claim.runs) {
      const { code, out } = reconcile(r.args)
      if (code !== r.exitCode) record(claim.id, `${r.args.join(' ')} exited ${code}, the table says ${r.exitCode}`)
      if (r.mentions && !out.includes(r.mentions)) {
        record(claim.id, `${r.args.join(' ')} did not name ${JSON.stringify(r.mentions)} in its refusal`)
      }
    }
    continue
  }

  const { code, out } = reconcile(claim.args)
  if (code !== 0 && !out.trim().startsWith('{')) {
    record(claim.id, `the tool exited ${code} with no result: ${out.slice(0, 200)}`)
    continue
  }
  let result
  try {
    result = JSON.parse(out)
  } catch {
    record(claim.id, `the tool did not produce a /2 result: ${out.slice(0, 200)}`)
    continue
  }

  const e = claim.expect
  if ('profile' in e && result.profile !== e.profile) {
    record(claim.id, `profile is ${JSON.stringify(result.profile)}, the table says ${JSON.stringify(e.profile)}`)
  }
  for (const [k, v] of Object.entries(e.bounds ?? {})) {
    if (result.bounds?.[k] !== v) {
      record(claim.id, `bounds.${k} is ${JSON.stringify(result.bounds?.[k])}, the table says ${JSON.stringify(v)}`)
    }
  }
  if (e.itemOutcomes) {
    const seen = (result.items ?? []).map((it) => it.outcome)
    if (JSON.stringify(seen) !== JSON.stringify(e.itemOutcomes)) {
      record(claim.id, `item outcomes are ${JSON.stringify(seen)}, the table says ${JSON.stringify(e.itemOutcomes)}`)
    }
  }
  if (e.excludedByRule) {
    const rules = (result.items ?? []).map((it) => it.rule?.id).filter(Boolean)
    if (!rules.includes(e.excludedByRule)) {
      record(claim.id, `no item names the rule ${JSON.stringify(e.excludedByRule)}; saw ${JSON.stringify(rules)}`)
    }
  }
}

assert.equal(
  failures.length,
  0,
  `${draftName} and this code disagree about what it does:\n${failures.join('\n')}\n\n` +
    '  Change the code back, or write the revision that says what the code now does.\n',
)

console.log(
  `implementation status: ${draftName} states ${bullets.length} observed behaviour(s), ` +
    `each one run against the shipped tool and still worded as it ran`,
)
