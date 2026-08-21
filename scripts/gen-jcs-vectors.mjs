#!/usr/bin/env node
/**
 * Generates the JCS class vectors under test-vectors/jcs/args/.
 *
 * Why these exist
 * ---------------
 * The thirteen receipt vectors are ASCII-keyed, with integer and string
 * values. A naive sorted-key serialiser reproduces every one of their hashes.
 * That was stated as a limit of the vectors, and the stated remedy was a
 * receipt carrying a float or a non-ASCII key.
 *
 * There is no such receipt. The receipt body is a fixed shape: its only
 * numbers are `chain.seq`, `masking.pii` and `outcome.rows`, all small
 * integers, and every key in it is ASCII. A float cannot appear in a
 * receipt's canonical bytes.
 *
 * The place where caller-shaped JSON does meet JCS is `hashArgs()`
 * (src/receipt.ts), which canonicalises the tool arguments an operator's
 * client sent — typed `any`, unbounded in shape. Its result is the
 * `request.argsHash` field. That preimage was published nowhere: vector 001
 * carries `sha256:abab...`, a placeholder standing in for a hash of nothing.
 *
 * So a second implementation could match all thirteen receipt hashes and
 * still disagree with us on the first non-ASCII tool argument it saw. These
 * vectors are the preimages that close that.
 *
 * The preimages are held below as raw JSON *text*, not as JavaScript values,
 * because one of them is a trap that only exists in the text: the digits
 * 9007199254740993 do not survive being parsed as a double. A generator that
 * round-tripped through a JS literal would silently drop the case it was
 * written to freeze.
 *
 *   node scripts/gen-jcs-vectors.mjs
 *
 * Refuses to overwrite. If a change to this repository breaks one of these,
 * the canonical form changed, and that is the signal they exist to raise.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalize, hashArgs } from '../dist/receipt.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const OUT = path.join(root, 'test-vectors', 'jcs', 'args')

/**
 * kind: 'json'   — the file holds a JSON document; it is parsed, then canonicalised.
 * kind: 'string' — the file holds raw bytes; hashArgs hashes them AS THEY ARE.
 *                  This branch does not canonicalise anything, and an
 *                  implementation that canonicalises it anyway will disagree.
 */
const CASES = [
  {
    name: '001-floats',
    kind: 'json',
    exercises:
      'RFC 8785 §3.2.2.3 number formatting: exponent boundary at 1e21, denormal minimum, negative zero, trailing zero',
    text: [
      '{',
      '  "ratio": 333333333.33333329,',
      '  "small": 2e-3,',
      '  "large": 1E30,',
      '  "trailing_zero": 4.50,',
      '  "below_exponent_boundary": 999999999999999900000,',
      '  "at_exponent_boundary": 1e21,',
      '  "denormal_min": 5e-324,',
      '  "negative_zero": -0,',
      '  "python_would_print_1e_06": 0.000001',
      '}',
    ].join('\n'),
  },
  {
    name: '002-integers-beyond-double',
    kind: 'json',
    exercises:
      'JSON numbers are IEEE-754 doubles. An implementation using arbitrary-precision integers produces different bytes for the same document.',
    text: [
      '{',
      '  "safe_max": 9007199254740991,',
      '  "not_representable": 9007199254740993,',
      '  "reference_pair_low": 9007199254740994,',
      '  "reference_pair_high": 9007199254740996',
      '}',
    ].join('\n'),
  },
  {
    name: '003-non-ascii-keys',
    kind: 'json',
    exercises:
      'Key order is over UTF-16 code units and MUST ignore locale. A French collation puts these in a different order.',
    text: [
      '{',
      '  "sin": "locale-independent",',
      '  "pêche": "e-circumflex U+00EA",',
      '  "péché": "e-acute U+00E9",',
      '  "peach": "ascii",',
      '  "École": "U+00C9 sorts after every ascii key, not next to E",',
      '  "ecole": "ascii e"',
      '}',
    ].join('\n'),
  },
  {
    name: '004-surrogate-key-order',
    kind: 'json',
    exercises:
      'The code-unit / code-point split. U+1F602 is stored as the surrogate pair D83D DE02; by code unit it sorts BEFORE U+FB33, by code point AFTER. Only one of those is RFC 8785.',
    text: [
      '{',
      '  "דּ": "U+FB33 hebrew letter dalet with dagesh",',
      '  "😂": "U+1F602 face with tears of joy",',
      '  "€": "U+20AC euro sign",',
      '  "z": "ascii tail"',
      '}',
    ].join('\n'),
  },
  {
    name: '005-string-escapes',
    kind: 'json',
    exercises:
      'RFC 8785 §3.2.2.2: which characters are escaped and which are emitted literally. Solidus is NOT escaped; C0 controls without a short form use \\u00XX lower case.',
    text: [
      '{',
      '  "quote_backslash": "\\"\\\\",',
      '  "solidus_stays_bare": "a/b",',
      '  "short_forms": "\\b\\f\\n\\r\\t",',
      '  "control_no_short_form": "\\u0000\\u001f\\u007f",',
      '  "literal_non_ascii": "€ é 😂"',
      '}',
    ].join('\n'),
  },
  {
    name: '006-nested-tool-args',
    kind: 'json',
    exercises:
      'The realistic shape: what an MCP client actually sends. Nesting, arrays whose order is preserved, and the classes above reached through a nested path.',
    text: [
      '{',
      '  "query": "select * from clients where montant > 0.1",',
      '  "limit": 100,',
      '  "filters": [',
      '    { "field": "montant", "op": ">", "value": 1234.5 },',
      '    { "field": "société", "op": "in", "value": ["FR", "DE"] }',
      '  ],',
      '  "options": { "timeout_s": 2e-3, "dry_run": false, "cursor": null }',
      '}',
    ].join('\n'),
  },
  {
    name: '007-null',
    kind: 'json',
    exercises:
      'The default path. audit.ts calls hashArgs(entry.args ?? null), so this is the hash every receipt with no arguments carries.',
    text: 'null',
  },
  {
    name: '008-raw-string',
    kind: 'string',
    exercises:
      'hashArgs does NOT canonicalise a string argument — it hashes the bytes it was handed. The bytes below are valid JSON, which is the trap: an implementation that parses and re-canonicalises produces a different hash for the same input.',
    text: '{"b":2,"a":1}',
  },
]

if (existsSync(path.join(OUT, 'expected-args-hashes.json'))) {
  console.error('refusing to overwrite: test-vectors/jcs/args/expected-args-hashes.json exists')
  console.error('these vectors are frozen. do not regenerate them to make a test pass.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const expected = { note: '', cases: [] }
for (const c of CASES) {
  const file = `${c.name}.${c.kind === 'string' ? 'txt' : 'json'}`
  writeFileSync(path.join(OUT, file), c.text, 'utf-8')

  const args = c.kind === 'string' ? c.text : JSON.parse(c.text)
  const argsHash = hashArgs(args)
  const canonical = c.kind === 'string' ? c.text : canonicalize(args)

  expected.cases.push({
    name: c.name,
    file,
    kind: c.kind,
    exercises: c.exercises,
    canonicalBytes: Buffer.byteLength(canonical, 'utf-8'),
    argsHash,
  })
  console.log(`${c.name.padEnd(28)} ${argsHash}`)
}

expected.note =
  'Preimages for request.argsHash. Feed the file to your hashArgs equivalent and compare. ' +
  'kind=json: parse, canonicalise (RFC 8785), SHA-256. ' +
  'kind=string: hash the bytes as they are — do NOT parse or re-canonicalise. ' +
  'Frozen: regenerate only if the canonical form itself changed on purpose.'

writeFileSync(
  path.join(OUT, 'expected-args-hashes.json'),
  JSON.stringify(expected, null, 2) + '\n',
  'utf-8',
)
console.log(`\nwrote ${CASES.length} preimages + expected-args-hashes.json`)
