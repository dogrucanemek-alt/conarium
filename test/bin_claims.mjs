#!/usr/bin/env node
/**
 * Every command the documentation tells a reader to run must be a command the
 * package actually installs.
 *
 * Found on 2026-08-17 by running the README on a machine that had never seen
 * this package: `npx conarium-anchor-service` — the documented way to start the
 * countersigning endpoint, the one announced on the SCITT list — returned
 * npm E404. The file was there (`bin/conarium-anchor-service.mjs`, shipped in
 * the tarball, correct shebang, fail-closed exit 2 on missing env). It had
 * simply never been listed in package.json "bin", so npm looked for a package
 * of that name in the registry instead. Two hand-maintained lists, neither
 * derived from the other, drifted for as long as the file existed.
 *
 * Both directions matter:
 *   - a documented command that is not installed is a broken instruction
 *   - an installed command that is documented nowhere is a surface nobody
 *     reviews, which is how the first kind happens
 *
 * The lists are read from the files, never restated here, so this test cannot
 * itself go stale.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bin = pkg.bin ?? {}

// ── 1. every registered bin resolves to a file that can actually be executed ──

for (const [name, rel] of Object.entries(bin)) {
  const target = join(root, rel)
  assert.ok(existsSync(target), `bin "${name}" points at ${rel}, which does not exist`)
  // dist/index.js is built, not committed; the shebang check applies to sources.
  if (rel.startsWith('bin/')) {
    const first = readFileSync(target, 'utf8').split('\n', 1)[0]
    assert.ok(
      first.startsWith('#!'),
      `bin "${name}" (${rel}) has no shebang, so npx cannot run it directly`,
    )
  }
}

// ── 2. every command the docs name must be registered ────────────────────────

const DOCS = ['README.md', 'README.tr.md', 'LIMITATIONS.md', 'SECURITY.md']
  .concat(readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`))

const named = new Map() // command -> where it was named

for (const rel of DOCS) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // `npx conarium-x` and `npm exec conarium-x` are the invocations a reader copies.
    for (const m of line.matchAll(/\b(?:npx|npm exec)\s+(?:--yes\s+)?(conarium[a-z0-9-]*)/g)) {
      if (!named.has(m[1])) named.set(m[1], `${rel}:${i + 1}`)
    }
  })
}

assert.ok(named.size > 0, 'no npx invocations were found in the docs — the scan is wrong')

const undocumented = Object.keys(bin).filter((n) => !named.has(n))
const uninstallable = [...named].filter(([n]) => !(n in bin))

assert.equal(
  uninstallable.length,
  0,
  'documented commands that this package does not install:\n' +
    uninstallable
      .map(([n, where]) => `  ${n}  (named at ${where})\n` +
        (existsSync(join(root, `bin/${n}.mjs`))
          ? `    bin/${n}.mjs exists — it is missing from package.json "bin"`
          : `    no bin/${n}.mjs either — the docs name a command that was never written`))
      .join('\n') +
    '\n\nnpx resolves an unregistered name against the registry, so a reader gets E404.\n',
)

// A bin nobody documents is not a build failure — some are internal helpers —
// but it is worth naming, because the drift above starts here.
if (undocumented.length > 0) {
  console.log(`bin claims: note — installed but not documented: ${undocumented.join(', ')}`)
}

console.log(
  `bin claims: ${Object.keys(bin).length} installed, ${named.size} documented, all documented commands install`,
)
