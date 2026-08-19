#!/usr/bin/env node
/**
 * `artefacts` mode must not be able to publish.
 *
 * The publish workflow has three dispatch modes and they differ only by an `if:`
 * on each step. `artefacts` exists so the steps that attach a tarball, an
 * attestation and a release page can be run against a version already on npm —
 * because those steps all execute *after* `npm publish`, so without it the first
 * release to use them is also the first test of them.
 *
 * That safety is one expression per step, and an expression is a thing a later
 * edit widens without noticing. A mode named for not publishing that publishes
 * is worse than not having the mode: it is a dispatch someone runs precisely
 * because they believe it is safe.
 *
 * So the rule here is derived rather than listed: whatever the file grows, no
 * step that publishes may be reachable in `artefacts` mode. The named matrix
 * below is the second, narrower check — it pins the steps that exist today,
 * and it is allowed to need updating when they change. The derived rule is not.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = '.github/workflows/publish.yml'
const yml = readFileSync(join(root, file), 'utf8')

const MODES = ['publish', 'registry', 'artefacts']

/**
 * Evaluate a workflow `if:` for one value of `inputs.confirm`.
 *
 * The expressions in this file are comparisons of that one input joined by
 * `||`. Anything richer than that is refused rather than guessed at — a guard
 * that silently answers "true" for syntax it does not understand is the failure
 * it was written to prevent.
 */
function runsIn(expr, mode) {
  if (expr === null) return true
  const body = expr.replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim()
  return body.split('||').some((clause) => {
    const m = /^\s*github\.event\.inputs\.confirm\s*(==|!=)\s*'([^']+)'\s*$/.exec(clause)
    assert.ok(m, `${file}: unsupported if: expression, refusing to guess — ${clause.trim()}`)
    return m[1] === '==' ? mode === m[2] : mode !== m[2]
  })
}

// ── steps, and the mode each one runs in ─────────────────────────────────────

const stepsBlock = yml.slice(yml.indexOf('\n    steps:'))
const chunks = stepsBlock.split(/\n      - /).slice(1)
assert.ok(chunks.length > 10, `${file}: parsed ${chunks.length} steps — has the layout changed?`)

const steps = chunks.map((chunk) => {
  const body = `      - ${chunk}`
  const name =
    /^\s*-\s*name:\s*(.+)$/m.exec(body)?.[1]?.trim() ??
    /^\s*-\s*uses:\s*(\S+)/m.exec(body)?.[1]?.trim() ??
    /^\s*-\s*run:\s*(.+)$/m.exec(body)?.[1]?.trim() ??
    '(unnamed)'
  const ifLine = /^\s{8}if:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null
  return { name, if: ifLine, body }
})

// ── the derived rule ─────────────────────────────────────────────────────────

const PUBLISHING = /npm\s+publish|mcp-publisher\s+publish|git\s+push\s+origin\s+"?v\$/

/**
 * Comments are stripped before the match, and the first version of this check
 * was red without it: a chunk ends where the next step begins, so the comment
 * block introducing the registry step sat at the tail of the release step, and
 * the sentence "this job holds the npm publish identity" read as a step that
 * publishes. A guard that fires on prose would be switched off within a week.
 */
const executable = (body) =>
  body
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

const leaks = steps.filter((s) => PUBLISHING.test(executable(s.body)) && runsIn(s.if, 'artefacts'))
assert.equal(
  leaks.length,
  0,
  `these steps publish and are reachable in artefacts mode:\n` +
    leaks.map((s) => `    ${s.name}`).join('\n') +
    `\n\n  artefacts mode attaches files to a release that already exists.\n` +
    `  A step that publishes, tags or registers must not be reachable from it.\n`,
)

// ── the named matrix, for the steps that exist today ─────────────────────────

const EXPECTED = {
  'Claims review gate': ['publish'],
  'The release tag must be free': ['publish'],
  'Publish with provenance': ['publish'],
  'Tag the release': ['publish'],
  'Software bill of materials': ['publish'],
  'Publish to the MCP Registry': ['publish', 'registry'],
  'The release must have a note': ['publish', 'artefacts'],
  'Fetch the published artefact and check its digest': ['publish', 'artefacts'],
  'Attest the release artefact': ['publish', 'artefacts'],
  'Create the GitHub release': ['publish', 'artefacts'],
}

for (const [name, expected] of Object.entries(EXPECTED)) {
  const step = steps.find((s) => s.name === name)
  assert.ok(step, `${file}: no step named "${name}" — update this matrix or restore the step`)
  const actual = MODES.filter((m) => runsIn(step.if, m))
  assert.deepEqual(
    actual,
    expected,
    `"${name}" runs in [${actual}], expected [${expected}]`,
  )
}

console.log(
  `publish modes GREEN — ${steps.length} steps, no publishing step reachable in artefacts mode, ` +
    `${Object.keys(EXPECTED).length} pinned`,
)
