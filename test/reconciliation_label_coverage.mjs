#!/usr/bin/env node
/**
 * Every label the reconciliation result can emit must have a conformance case
 * that produces it.
 *
 * The cases exist and they are good: conformance/cases/reconciliation/ covers
 * every outcome and gives each independent ground for `indeterminate` a case of
 * its own. Nothing checked that the coverage stays that way. Delete the only
 * case that reaches a label and the class gets smaller in silence, which is the
 * failure this project is named after: the record still verifies, and what is
 * missing from it leaves no trace.
 *
 * The label list is not written here. It is read from the tool's own result, so
 * a label added to the vocabulary arrives in this check without anyone
 * remembering to add it — and arrives red, because no case produces it yet.
 *
 * Red first: remove any case file under conformance/cases/reconciliation/ and
 * the label it was the last producer of is named.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const caseDir = join(root, 'conformance', 'cases', 'reconciliation')
const fixtures = join(root, 'conformance', 'fixtures', 'reconciliation')

// ── the vocabulary, asked of the tool rather than restated here ──────────────
function labelsFromTool() {
  // The tool exits non-zero when the reconciliation has exceptions, and still
  // prints the result. The exit code is the verdict; the result is the reading.
  const argv = [
      join(root, 'bin', 'conarium-reconcile.mjs'),
      '--before',
      join(fixtures, 'before-empty.json'),
      '--after',
      join(fixtures, 'after-customers-1.json'),
      '--receipts',
      join(fixtures, 'receipts-customers-early.jsonl'),
      '--json-v2',
  ]
  let out
  try {
    out = execFileSync(process.execPath, argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    out = err.stdout ?? ''
  }
  assert.ok(out.trim().startsWith('{'), `no /2 result to read the vocabulary from: ${out.trim().slice(0, 160)}`)
  const counts = JSON.parse(out).counts
  assert.ok(counts && typeof counts === 'object', 'the /2 result carries no counts to read the vocabulary from')
  return Object.keys(counts)
}

const labels = labelsFromTool()

// ── which labels the cases claim to produce ─────────────────────────────────
const producedBy = new Map(labels.map((l) => [l, []]))
for (const file of readdirSync(caseDir).filter((n) => n.endsWith('.json'))) {
  const c = JSON.parse(readFileSync(join(caseDir, file), 'utf-8'))
  for (const outcome of c.expectItemOutcomes ?? []) {
    if (producedBy.has(outcome)) producedBy.get(outcome).push(file)
  }
  for (const [label, n] of Object.entries(c.expectCounts ?? {})) {
    if (n > 0 && producedBy.has(label)) producedBy.get(label).push(file)
  }
}

const uncovered = labels.filter((l) => producedBy.get(l).length === 0)
assert.deepEqual(
  uncovered,
  [],
  `the result can emit ${uncovered.length} label(s) that no conformance case produces:\n` +
    uncovered.map((l) => `    ${l}`).join('\n') +
    '\n\n  A label no case exercises is a word the specification cannot be held to.\n',
)

// ── each ground for indeterminate keeps its own case ─────────────────────────
// A label reached two ways has not been tested twice. The grounds are read from
// the case files that carry them, so a ground that loses its last case is named.
const grounds = new Set()
for (const file of readdirSync(caseDir).filter((n) => n.startsWith('v2-neg-'))) {
  grounds.add(file.replace(/^v2-neg-/, '').replace(/\.json$/, ''))
}
assert.ok(
  grounds.size >= 4,
  `indeterminate had four independent grounds, each with a negative case of its own; ${grounds.size} remain: ` +
    `${[...grounds].sort().join(', ')}`,
)

console.log(
  `reconciliation labels: ${labels.length} in the vocabulary, each produced by a case ` +
    `(${labels.map((l) => `${l}:${producedBy.get(l).length}`).join(' ')}), ` +
    `${grounds.size} isolated grounds for indeterminate`,
)
