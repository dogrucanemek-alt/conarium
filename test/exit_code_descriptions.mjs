#!/usr/bin/env node
/**
 * The same exit code is described in three places. They have to agree.
 *
 * `spec_exitcode_drift.mjs` compares the *set* of codes in the binaries with
 * the set in the documented tables, both directions. That is a real check and
 * it is blind to the thing that keeps going wrong. It was green while 20 named
 * two different events, because 20 was in both sets. It was green while
 * `manifest.json` described 13 as "signature invalid or missing while a pubkey
 * was supplied" — a sentence that is false in exactly the case 13 is returned
 * for, since 13 is what you get when no pubkey was supplied. And it was green
 * while the manifest and the specification gave code 2 two different meanings
 * in the same release.
 *
 * An implementer reading `test-vectors/manifest.json` and an implementer
 * reading `docs/RECEIPT-SPEC.md` must not come away with different contracts.
 * The manifest is the machine-readable one, so when they disagree it is the
 * one that does the damage.
 *
 * Two comparisons, both mechanical:
 *
 *   1. `manifest.json` and `scripts/gen-test-vectors.mjs` hold the same map.
 *      The generator writes the manifest, so they are the same fact written
 *      twice, and the second copy goes stale the first time someone edits the
 *      output by hand instead of regenerating.
 *
 *   2. Every manifest description is the leading clause of the specification's
 *      row for that code. The manifest is allowed to be shorter — a machine
 *      reads it — but not to say something else. A prefix rule is what makes
 *      that checkable without asking a program to judge prose.
 *
 * What it still cannot see: whether either description is true of the binary.
 * `exit_contract.mjs` asks that question of the codes and cannot ask it of the
 * sentences. Nothing here closes that, and the honest thing is to say so
 * rather than let a green run imply it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const manifest = JSON.parse(
  readFileSync(join(root, 'test-vectors/manifest.json'), 'utf-8'),
)
const generator = readFileSync(join(root, 'scripts/gen-test-vectors.mjs'), 'utf-8')
const spec = readFileSync(join(root, 'docs/RECEIPT-SPEC.md'), 'utf-8')

const failures = []

/**
 * The generator's map, read out of the source rather than by running it: the
 * generator rewrites every vector, and a check that regenerates the tree to
 * compare one object is a check nobody will run twice.
 */
function generatorMap(text) {
  const block = text.match(/exitCodes:\s*\{([\s\S]*?)\n\s*\},/)
  if (!block) throw new Error('no exitCodes block in scripts/gen-test-vectors.mjs')
  const map = {}
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(\d+):\s*'(.*)',\s*$/)
    if (m) map[m[1]] = m[2]
  }
  if (!Object.keys(map).length) throw new Error('exitCodes block parsed to nothing')
  return map
}

/** The verifier's table: the first `| Exit | Meaning |` in the document. */
function specRows(text) {
  const start = text.indexOf('| Exit | Meaning |')
  if (start < 0) throw new Error('no exit table in docs/RECEIPT-SPEC.md')
  const rows = {}
  for (const line of text.slice(start).split('\n')) {
    if (!line.startsWith('|')) break
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*$/)
    if (m) rows[m[1]] = m[2]
  }
  if (!Object.keys(rows).length) throw new Error('exit table parsed to nothing')
  return rows
}

/** Markdown, case and punctuation spacing are not part of the claim. */
function normalise(s) {
  return s
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const gen = generatorMap(generator)
const rows = specRows(spec)

for (const [code, text] of Object.entries(manifest.exitCodes)) {
  if (gen[code] === undefined) {
    failures.push(
      `${code}: in manifest.json, absent from the generator's map — regenerate rather than hand-edit`,
    )
  } else if (gen[code] !== text) {
    failures.push(
      `${code}: the two machine-readable copies disagree\n` +
        `      manifest.json  ${text}\n` +
        `      gen-test-vectors.mjs  ${gen[code]}`,
    )
  }

  const row = rows[code]
  if (row === undefined) {
    failures.push(`${code}: in manifest.json, absent from the verifier table in RECEIPT-SPEC.md`)
    continue
  }
  if (!normalise(row).startsWith(normalise(text))) {
    failures.push(
      `${code}: the manifest says something the specification does not open with\n` +
        `      manifest.json  ${text}\n` +
        `      RECEIPT-SPEC   ${row}\n` +
        '      The manifest may be shorter than the row. It may not say something else.',
    )
  }
}

if (failures.length) {
  console.error(`exit code descriptions FAIL\n\n  ${failures.join('\n\n  ')}\n`)
  process.exit(1)
}

console.log(
  `exit code descriptions GREEN — ${Object.keys(manifest.exitCodes).length} code(s) described ` +
    'identically by the generator and consistently with the verifier table ' +
    '(agreement between the texts; neither is checked against the binary)',
)
