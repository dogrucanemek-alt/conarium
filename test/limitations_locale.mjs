#!/usr/bin/env node
/**
 * Every LIMITATIONS.md section must have a counterpart in LIMITATIONS.tr.md.
 *
 * Pairing cannot use the heading text: the Turkish page is written, not
 * translated, so the titles will never match. Each section carries a stable
 * key in an HTML comment (`<!-- s: node-20-floor -->`). This file compares
 * the two key sets. A key only on one side is a reader in that language
 * being told less, or more, than the other — the same shape that left the
 * SOC 2 answer off the Turkish page in 0.2.26.
 *
 * Missing key → exit 1. Extra key → exit 1. Heading without a key → exit 1.
 * Duplicate key → exit 1.
 *
 * Generalising to README.md ↔ README.tr.md is the same check. This file
 * stays on one pair until the red-green evidence exists here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const KEY_RE = /<!--\s*s:\s*([a-z0-9][a-z0-9.-]*)\s*-->/
const HEADING_RE = /^##\s+\S/

function sections(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  const lines = text.split(/\r?\n/)
  const headings = []
  const keys = []
  const missingKey = []
  const seen = new Map()
  const duplicates = []

  for (let i = 0; i < lines.length; i++) {
    if (!HEADING_RE.test(lines[i])) continue
    headings.push({ line: i + 1, text: lines[i].slice(3).trim() })
    let key = null
    const same = KEY_RE.exec(lines[i])
    if (same) key = same[1]
    else {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (HEADING_RE.test(lines[j])) break
        const m = KEY_RE.exec(lines[j])
        if (m) {
          key = m[1]
          break
        }
        if (lines[j].trim() && !/^<!--/.test(lines[j].trim())) break
      }
    }
    if (!key) {
      missingKey.push({ file: rel, line: i + 1, text: lines[i] })
      continue
    }
    if (seen.has(key)) {
      duplicates.push({ key, first: seen.get(key), second: `${rel}:${i + 1}` })
    } else {
      seen.set(key, `${rel}:${i + 1}`)
    }
    keys.push(key)
  }
  return { rel, headings, keys, missingKey, duplicates, set: new Set(keys) }
}

const en = sections('LIMITATIONS.md')
const tr = sections('LIMITATIONS.tr.md')

const errors = []
for (const row of [...en.missingKey, ...tr.missingKey]) {
  errors.push(`  no key  ${row.file}:${row.line}  ${row.text}`)
}
for (const d of [...en.duplicates, ...tr.duplicates]) {
  errors.push(`  duplicate key "${d.key}"  ${d.first}  ${d.second}`)
}

const onlyEn = [...en.set].filter((k) => !tr.set.has(k)).sort()
const onlyTr = [...tr.set].filter((k) => !en.set.has(k)).sort()
for (const k of onlyEn) errors.push(`  missing in LIMITATIONS.tr.md  s:${k}`)
for (const k of onlyTr) errors.push(`  extra in LIMITATIONS.tr.md  s:${k}`)

if (en.headings.length === 0) errors.push('  LIMITATIONS.md has no ## headings')
if (tr.headings.length === 0) errors.push('  LIMITATIONS.tr.md has no ## headings')

if (errors.length) {
  console.error('limitations locale: section keys do not match')
  for (const e of errors) console.error(e)
  console.error(`  en headings=${en.headings.length} keys=${en.keys.length}  tr headings=${tr.headings.length} keys=${tr.keys.length}`)
  process.exit(1)
}

console.log(
  `limitations locale: ${en.keys.length} section keys match (${en.rel} ↔ ${tr.rel})`,
)
process.exit(0)
