#!/usr/bin/env node
/**
 * Files npm ships must not carry Turkish-specific letters.
 *
 * A stranger installing the package was reading fail-closed messages in
 * Turkish. The letters are the defect: if they appear in a packed file,
 * the next operator will see them. This check asks npm what it would
 * ship, then reads those files. A hand-written file list would miss the
 * next path the way the old pin check missed seven workflows.
 *
 * Allowed, and only these:
 *   - `*.tr.md` — the Turkish copy of a document, on purpose
 *   - measured PII examples and registered legal names (same residue as
 *     locale_letters)
 *   - detector tokens that match Turkish PII in customer data
 *   - the default pseudonym prefix `Kayıt` (renaming it would change maps)
 * Scope is the code a stranger runs: `dist/`, `bin/`, `scripts/`, `public/`.
 * Historical notes under `docs/` and CHANGELOG are a different surface
 * (locale_letters already watches the published English pages).
 *
 * The allow-list is not a place to grow. A new Turkish file belongs in
 * `*.tr.md` or it does not ship.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localeResidue } from './claim_discipline.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LETTERS = /[çğıöşüÇĞİÖŞÜ]/
const TEXT = /\.(?:js|mjs|cjs|ts|json|md|html|css|sql|txt|map|yml|yaml|xml|svg)$/i

/** Tokens the PII detectors must keep matching. Not interface language. */
const DETECTOR = [
  /Sayın/g,
  /müşteri/g,
  /kişi/g,
  /adı soyadı/g,
  /Yılmaz/g,
  /Ayşe/g,
  /Ahmet/g,
  /Kayıt/g,
  /"ş"/g,
]

function packedFiles() {
  const out = execFileSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  const parsed = JSON.parse(out.trim())
  const listing = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  assert.ok(listing?.files?.length, 'npm pack --dry-run returned no file list')
  return listing.files.map((f) => f.path.replace(/\\/g, '/'))
}

const SCOPE = /^(dist|bin|scripts|public)\//

function allowedFile(rel) {
  if (rel.endsWith('.tr.md')) return true
  return !SCOPE.test(rel)
}

function residue(line) {
  let text = localeResidue(line)
  for (const re of DETECTOR) text = text.replace(re, '')
  return text
}

function hitsIn(rel) {
  if (allowedFile(rel)) return []
  if (!TEXT.test(extname(rel)) && !rel.endsWith('package.json')) return []
  const raw = readFileSync(join(root, rel), 'utf-8')
  const found = []
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (!LETTERS.test(residue(line))) continue
    found.push(`${rel}:${i + 1}`)
    if (found.length >= 20) break
  }
  return found
}

const files = packedFiles()
const hits = files.flatMap(hitsIn)
if (hits.length) {
  console.error(`pack locale RED — Turkish-specific letters in packed files:\n  ${hits.join('\n  ')}`)
  process.exit(1)
}
console.log(`pack locale GREEN — ${files.length} packed path(s), 0 Turkish-specific letters outside the allow-list`)
