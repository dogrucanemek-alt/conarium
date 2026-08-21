#!/usr/bin/env node
/**
 * JCS class guard.
 *
 * What this replaces
 * ------------------
 * The thirteen receipt vectors are ASCII-keyed with integer and string values,
 * so a naive sorted-key serialiser reproduces all thirteen hashes. That was
 * stated as a limit, and the remedy named in the same paragraph was "a receipt
 * carrying a float, a large integer, or a non-ASCII key".
 *
 * No such receipt can exist. The receipt body is a fixed shape whose only
 * numbers are `chain.seq`, `masking.pii` and `outcome.rows` — small integers —
 * and every key in it is ASCII. Check 5 below measures that, so the claim is
 * not prose. The limit was announced in the wrong place.
 *
 * Caller-shaped JSON reaches JCS at exactly one point: `hashArgs()`, whose
 * argument is typed `any` and whose result is `request.argsHash`. That is the
 * surface a second implementation has to agree with us on, and until these
 * vectors existed its preimages were published nowhere.
 *
 * What is measured
 * ----------------
 * 1. The reference's own six input/expected pairs, compared over BYTES.
 * 2. The reference's published number vectors — a sample; see PROVENANCE.md.
 * 3. Our args preimages against their frozen hashes.
 * 4. The mutants, which MUST fail. A guard that cannot go red is decoration;
 *    three separate checks in this repository reported success without
 *    comparing anything before anyone noticed.
 * 5. That no shipped receipt vector carries a float or a non-ASCII key —
 *    the fact the rewritten prose rests on.
 * 6. That the prose states the sample size the fixture actually has.
 *
 *   node test/spec_jcs_class.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalize, hashArgs } from '../dist/receipt.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const JCS = path.join(root, 'test-vectors', 'jcs')
const REF = path.join(JCS, 'rfc8785')
const ARGS = path.join(JCS, 'args')
const VECTORS = path.join(root, 'test-vectors')

const failures = []
const notes = []
const fail = (m) => failures.push(m)
const pass = (m) => notes.push(`PASS  ${m}`)
const read = (p) => readFileSync(p, 'utf-8')

const REF_FILES = ['arrays', 'french', 'structures', 'unicode', 'values', 'weird']
const expectedBytes = (name) =>
  Buffer.from(read(path.join(REF, 'outhex', `${name}.txt`)).trim().split(/\s+/).join(''), 'hex')
const refInput = (name) => JSON.parse(read(path.join(REF, 'input', `${name}.json`)))

// ---------------------------------------------------------------- 1. fixtures

let refOk = 0
for (const name of REF_FILES) {
  const want = expectedBytes(name)
  let got
  try {
    got = Buffer.from(canonicalize(refInput(name)), 'utf-8')
  } catch (err) {
    fail(`rfc8785/${name}: canonicalize threw — ${err.message}`)
    continue
  }
  if (got.equals(want)) {
    refOk++
    continue
  }
  const n = Math.min(got.length, want.length)
  let i = 0
  while (i < n && got[i] === want[i]) i++
  fail(
    `rfc8785/${name}: first divergence at byte ${i} — reference 0x${(want[i] ?? 0).toString(16)}, ours 0x${(got[i] ?? 0).toString(16)}`,
  )
}
if (refOk === REF_FILES.length) pass(`${refOk}/${REF_FILES.length} RFC 8785 reference pairs match byte for byte`)

// ------------------------------------------------------------- 2. numbers

const numberLines = read(path.join(REF, 'es6-numbers-sample.txt')).split('\n').filter(Boolean)
const u64 = new BigUint64Array(1)
const f64 = new Float64Array(u64.buffer)
const doubleOf = (hex) => {
  u64[0] = BigInt(`0x${hex}`)
  return f64[0]
}

let numBad = 0
let firstNumBad = null
for (const line of numberLines) {
  const comma = line.indexOf(',')
  const value = doubleOf(line.slice(0, comma))
  const want = line.slice(comma + 1)
  let got
  try {
    got = canonicalize(value)
  } catch (err) {
    got = `threw: ${err.message}`
  }
  if (got !== want) {
    numBad++
    if (!firstNumBad) firstNumBad = `${line.slice(0, comma)} — reference ${want}, ours ${got}`
  }
}
if (numBad > 0) {
  fail(`es6 numbers: ${numBad}/${numberLines.length} disagree with the reference. First: ${firstNumBad}`)
} else {
  pass(`${numberLines.length} published IEEE-754 doubles serialise identically (SAMPLED — see rfc8785/PROVENANCE.md)`)
}

// ---------------------------------------------------------------- 3. args

const expectedArgs = JSON.parse(read(path.join(ARGS, 'expected-args-hashes.json')))
let argsOk = 0
for (const c of expectedArgs.cases) {
  const raw = read(path.join(ARGS, c.file))
  const input = c.kind === 'string' ? raw : JSON.parse(raw)
  const got = hashArgs(input)
  if (got === c.argsHash) argsOk++
  else fail(`args/${c.name}: frozen ${c.argsHash}, got ${got}`)
}
const onDisk = readdirSync(ARGS).filter((f) => f !== 'expected-args-hashes.json' && !f.endsWith('.md')).length
if (onDisk !== expectedArgs.cases.length) {
  fail(`args: ${onDisk} preimage files on disk, ${expectedArgs.cases.length} declared — a vector was added or removed without its hash`)
} else if (argsOk === expectedArgs.cases.length) {
  pass(`${argsOk} argsHash preimages match their frozen hashes`)
}

// -------------------------------------------------------------- 4. mutants

function makeCanon({ sort, escapeNonAscii, num } = {}) {
  const str = (s) => {
    const j = JSON.stringify(s)
    if (!escapeNonAscii) return j
    return [...j]
      .map((ch) =>
        ch.charCodeAt(0) > 127
          ? `${String.fromCharCode(92)}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
          : ch,
      )
      .join('')
  }
  const val = (v) => {
    if (v === null) return 'null'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return num ? num(v) : JSON.stringify(v)
    if (typeof v === 'string') return str(v)
    if (Array.isArray(v)) return `[${v.map(val).join(',')}]`
    return `{${Object.keys(v)
      .sort(sort)
      .map((k) => `${str(k)}:${val(v[k])}`)
      .join(',')}}`
  }
  return val
}

const byCodePoint = (a, b) => {
  const A = [...a].map((c) => c.codePointAt(0))
  const B = [...b].map((c) => c.codePointAt(0))
  const n = Math.min(A.length, B.length)
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) return A[i] - B[i]
  return A.length - B.length
}

/** Each mutant is one way a real implementation gets JCS wrong. All must be caught. */
const MUTANTS = [
  { name: 'locale key order', on: 'fixtures', canon: makeCanon({ sort: (a, b) => a.localeCompare(b) }) },
  { name: 'code POINT key order (not code unit)', on: 'fixtures', canon: makeCanon({ sort: byCodePoint }) },
  { name: 'non-ASCII escaped to \\uXXXX', on: 'fixtures', canon: makeCanon({ escapeNonAscii: true }) },
  { name: 'numbers via toPrecision(17)', on: 'fixtures', canon: makeCanon({ num: (v) => (Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : v.toPrecision(17)) }) },
  { name: 'upper-case exponent (Go %G)', on: 'numbers', num: (v) => String(v).replace('e', 'E') },
  { name: 'exponent without +', on: 'numbers', num: (v) => String(v).replace('e+', 'e') },
  { name: 'two-digit exponent (Python 1e-06)', on: 'numbers', num: (v) => String(v).replace(/e([+-])(\d)$/, 'e$10$2') },
  { name: 'negative zero preserved', on: 'numbers', num: (v) => (Object.is(v, -0) ? '-0' : String(v)) },
]

let mutantsCaught = 0
for (const m of MUTANTS) {
  let caught = 0
  if (m.on === 'fixtures') {
    for (const name of REF_FILES) {
      let got
      try {
        got = Buffer.from(m.canon(refInput(name)), 'utf-8')
      } catch {
        caught++
        continue
      }
      if (!got.equals(expectedBytes(name))) caught++
    }
  } else {
    for (const line of numberLines) {
      const comma = line.indexOf(',')
      let got
      try {
        got = m.num(doubleOf(line.slice(0, comma)))
      } catch {
        caught++
        continue
      }
      if (got !== line.slice(comma + 1)) caught++
    }
  }
  if (caught === 0) {
    fail(`mutant "${m.name}" produced the reference bytes on every case — this guard cannot see that failure mode`)
  } else {
    mutantsCaught++
  }
}
if (mutantsCaught === MUTANTS.length) {
  pass(`${mutantsCaught} mutants all caught — the comparison is live, not decorative`)
}

// ------------------------------------------- 5. no receipt can carry the class

const asciiKey = (k) => [...k].every((c) => c.charCodeAt(0) < 128)
const walkKeys = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => walkKeys(x, out))
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push([k, x])
      walkKeys(x, out)
    }
  return out
}

let receiptsSeen = 0
let offenders = 0
let nonAsciiValues = 0
for (const dir of readdirSync(VECTORS, { withFileTypes: true })) {
  if (!dir.isDirectory() || !/^\d{3}-/.test(dir.name)) continue
  const file = path.join(VECTORS, dir.name, 'receipts.jsonl')
  let text
  try {
    text = read(file)
  } catch {
    continue
  }
  for (const line of text.split('\n').filter(Boolean)) {
    const receipt = JSON.parse(line)
    receiptsSeen++
    for (const [k, v] of walkKeys(receipt)) {
      if (!asciiKey(k)) {
        fail(`${dir.name}: non-ASCII key ${JSON.stringify(k)} in a receipt — the spec paragraph says this cannot happen`)
        offenders++
      }
      if (typeof v === 'number' && !Number.isSafeInteger(v)) {
        fail(`${dir.name}: key ${JSON.stringify(k)} carries ${v}, not a safe integer — the spec paragraph says this cannot happen`)
        offenders++
      }
      // Counted, never failed. Receipt KEYS are fixed by the format; receipt
      // VALUES are free text and nothing constrains them to ASCII. A receipt
      // whose actor.id is not ASCII exercises string escaping through
      // receiptHash, so hashArgs is not the only way two implementations can
      // part company. The count keeps that sentence honest as the vectors grow.
      if (typeof v === 'string' && [...v].some((c) => c.charCodeAt(0) > 127)) nonAsciiValues++
    }
  }
}
if (receiptsSeen === 0) fail('no receipt vectors found — check 5 measured nothing')
else if (offenders === 0)
  pass(
    `${receiptsSeen} shipped receipts: every key ASCII, every number a safe integer, ${nonAsciiValues} non-ASCII string value(s) — values are unconstrained, so this is a count, not a rule`,
  )

// ------------------------------------------------- 6. prose states the sample

const DOCS = [
  path.join(root, 'docs', 'RECEIPT-SPEC.md'),
  path.join(VECTORS, 'README.md'),
]
const deliberateBlock = 2168
let claimsSeen = 0
for (const doc of DOCS) {
  let text
  try {
    text = read(doc)
  } catch {
    continue
  }
  const m = text.match(/([\d,]+)\s+published IEEE-754/)
  if (!m) continue
  claimsSeen++
  const stated = Number(m[1].replace(/,/g, ''))
  if (stated !== numberLines.length) {
    fail(
      `${path.relative(root, doc)} says ${stated} published doubles; the vendored sample has ${numberLines.length}`,
    )
  }
}
if (claimsSeen === 0) {
  fail('neither RECEIPT-SPEC.md nor test-vectors/README.md states the sample size — the number can drift unmeasured')
} else {
  pass(`${claimsSeen} document(s) state the sample size, and it matches the fixture (${numberLines.length}, of which ${deliberateBlock} deliberate)`)
}

for (const n of notes) console.log(n)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`)
  console.error(`\njcs class: ${failures.length} failed`)
  process.exit(1)
}
console.log(`\njcs class: ${notes.length} checks, all green`)
