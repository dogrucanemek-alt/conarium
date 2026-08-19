#!/usr/bin/env node
/**
 * The release-note reader that publish.yml stands on.
 *
 * A gate is only worth the red it can produce, so this exercises the red first:
 * a version with no section, a section with nothing in it, and a changelog that
 * declares the same version twice. Then it runs the real script against the real
 * CHANGELOG.md, because a parser that passes on fixtures and throws on the
 * actual file would take the publish down at the one moment it must not.
 *
 * It also prints which published versions have no changelog section. That is a
 * warning and not a failure on purpose. Four of them (0.2.9 through 0.2.12) date
 * from before anything asked, and turning them red here would mean either
 * writing archaeology to get CI green or deleting the check — both of which end
 * with the question unasked. The version being published is the one that has to
 * be answered, and publish.yml refuses that one outright.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { noteFor, sections } from '../.github/scripts/release-notes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, '.github', 'scripts', 'release-notes.mjs')

const throws = (fn, re, what) => {
  let raised = null
  try {
    fn()
  } catch (err) {
    raised = err
  }
  assert.ok(raised, `expected a refusal: ${what}`)
  assert.match(raised.message, re, `wrong refusal for ${what}: ${raised.message}`)
}

// ── red ──────────────────────────────────────────────────────────────────────

const sample = ['# Changelog', '', '## 1.2.0 — 2026-01-02', '', 'A thing changed.', ''].join('\n')

throws(() => noteFor(sample, '1.3.0'), /no "## 1\.3\.0" section/, 'a version with no section')

throws(
  () => noteFor('# Changelog\n\n## 1.2.0 — 2026-01-02\n\n', '1.2.0'),
  /is empty/,
  'a section with no body',
)

throws(
  () => sections('## 1.2.0 — 2026-01-02\n\nfirst\n\n## 1.2.0 — 2026-01-03\n\nsecond\n'),
  /more than once/,
  'the same version declared twice',
)

// ── green ────────────────────────────────────────────────────────────────────

const plain = noteFor(sample, '1.2.0')
assert.equal(plain.title, 'Conarium 1.2.0', 'a heading with no third segment titles itself')
assert.equal(plain.body, 'A thing changed.')

const titled = noteFor('## 1.2.0 — 2026-01-02 — the pin nobody advanced\n\nBody.\n', '1.2.0')
assert.equal(
  titled.title,
  'Conarium 1.2.0 — the pin nobody advanced',
  'the third heading segment becomes the release title',
)
assert.equal(titled.body, 'Body.')

// The body must stop at the next release, or every note would carry the whole
// history below it.
const two = '## 1.2.0 — 2026-01-02\n\nnewer\n\n## 1.1.0 — 2026-01-01\n\nolder\n'
assert.equal(noteFor(two, '1.2.0').body, 'newer')
assert.equal(noteFor(two, '1.1.0').body, 'older')

// ── the real file, through the real command line ─────────────────────────────

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const documented = sections(changelog)
assert.ok(documented.size > 0, 'CHANGELOG.md has no version sections at all')

const newest = [...documented.keys()][0]
const run = (args) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf-8' }).trim()

assert.ok(run([newest, '--title']).startsWith(`Conarium ${newest}`), 'CLI --title')
assert.ok(run([newest, '--body']).length > 0, 'CLI --body returned nothing')

let refused = false
try {
  execFileSync(process.execPath, [script, '99.99.99', '--body'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: 'pipe',
  })
} catch (err) {
  refused = err.status === 1
}
assert.ok(refused, 'the CLI must exit 1 for a version with no section')

// ── coverage, reported ───────────────────────────────────────────────────────

let missing = []
try {
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf-8' })
    .split('\n')
    .map((t) => t.trim().slice(1))
    .filter(Boolean)
  missing = tags.filter((v) => !documented.has(v))
} catch {
  // No git, no tags to compare against; the assertions above still ran.
}

if (missing.length) {
  console.log(`release notes: ${missing.length} published version(s) have no changelog section:`)
  console.log(`  ${missing.sort().join(', ')}`)
  console.log('  publish.yml refuses to release a version that is in this list.')
}

console.log(
  `release notes GREEN — ${documented.size} section(s), newest ${newest}, red paths proven`,
)
