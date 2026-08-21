#!/usr/bin/env node
/**
 * Wire-contract guard.
 *
 * An independent implementer read test-vectors/README.md and the IETF draft,
 * wrote a verifier from scratch, and could not reach 13/13 without opening our
 * source. Four things were unstated: what the signature actually covers, that
 * `seq` must advance by exactly one, which field absences are schema errors,
 * and in what ORDER the checks run. A spec that needs its own implementation
 * read alongside it is not a spec.
 *
 * So the sentences that close those gaps are not left as prose. Each one below
 * is measured against the shipped verifier, and the document must state the
 * measured value. If the code changes and the sentence does not, this fails.
 *
 *   node test/spec_wire_contract.mjs
 */
import { execFileSync } from 'node:child_process'
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const VECTORS = path.join(root, 'test-vectors')
const SPEC = path.join(root, 'docs', 'RECEIPT-SPEC.md')
const VECTOR_README = path.join(VECTORS, 'README.md')
const TOP_README = path.join(root, 'README.md')

const failures = []
const notes = []
const fail = (m) => failures.push(m)
const pass = (m) => notes.push(`PASS  ${m}`)

const read = (p) => readFileSync(p, 'utf-8')
const manifest = JSON.parse(read(path.join(VECTORS, 'manifest.json')))
const specText = read(SPEC)

function strip(r) {
  const copy = { ...r }
  delete copy.hash
  delete copy.sig
  delete copy.anchor
  if (copy.chain && typeof copy.chain === 'object') {
    const chain = { ...copy.chain }
    delete chain.hash
    copy.chain = chain
  }
  return copy
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// ---------------------------------------------------------------- 1. signature
// The gap that stopped the independent implementer at case 001: Ed25519 signs
// the UTF-8 bytes of chain.hash INCLUDING the "sha256:" prefix. The other three
// encodings below are the obvious guesses, and all three must be rejected — a
// document that only says "signature over chain.hash" leaves the choice open.

const receipt = JSON.parse(read(path.join(VECTORS, '001-single-receipt', 'receipts.jsonl')).trim())
const pubKey = createPublicKey(read(path.join(VECTORS, 'keys', 'vector-key.pub.pem')))
const sigBuf = Buffer.from(receipt.sig.value, 'base64')

const rightPayload = Buffer.from(receipt.chain.hash, 'utf-8')
const bareHex = receipt.chain.hash.replace(/^sha256:/, '')

const candidates = [
  ['prefixed hash string, UTF-8', rightPayload, true],
  ['raw 32-byte digest', Buffer.from(bareHex, 'hex'), false],
  ['hex digest without the sha256: prefix', Buffer.from(bareHex, 'utf-8'), false],
  ['canonical JSON of the receipt', Buffer.from(sortedJson(strip(receipt)), 'utf-8'), false],
]

for (const [label, payload, expected] of candidates) {
  const got = cryptoVerify(null, payload, pubKey, sigBuf)
  if (got !== expected) {
    fail(`signature payload "${label}": expected verify=${expected}, got ${got}`)
  } else {
    pass(`signature payload ${expected ? 'accepts' : 'rejects'} ${label}`)
  }
}

// The byte length is the cheapest thing an implementer can compare their own
// payload against, so the document carries the measured number, not a
// remembered one.
const payloadBytes = rightPayload.length
if (!new RegExp(`\\b${payloadBytes}\\s+bytes\\b`).test(specText)) {
  fail(`RECEIPT-SPEC.md does not state the signed payload length (${payloadBytes} bytes)`)
} else {
  pass(`spec states the signed payload length (${payloadBytes} bytes)`)
}

// ------------------------------------------------------------------- 2. order
// Check order is a wire fact, not an implementation detail: run the checks in a
// different order and 003/004/005 come back as 13 ("bad signature") instead of
// 10/11/12. The diagnosis, not just the verdict, is part of the contract.
//
// Each case is made to fail TWO checks at once and the exit code names which
// check ran first. The signature is removed from ONE receipt — the one the
// pristine vector already fails on, learned from --json rather than assumed.
// Stripping every receipt proves nothing: the file's first receipt would fail
// the signature check before the chain break is ever reached, and the guard
// would report 13 for a verifier that orders its checks correctly.

const tmp = mkdtempSync(path.join(tmpdir(), 'cnr-wire-'))
const VERIFY = path.join(root, 'bin', 'conarium-verify.mjs')

function runVerify(target, args, extra = []) {
  try {
    const out = execFileSync(process.execPath, [VERIFY, target, ...args, ...extra], {
      stdio: 'pipe',
      cwd: root,
      encoding: 'utf-8',
    })
    return { code: 0, out }
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : -1, out: err.stdout || '' }
  }
}

function lastJsonLine(text) {
  const lines = text.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {
      /* not the json line */
    }
  }
  return null
}

// Control for the fixtures below: a receipt with no other defect, signature
// removed, must exit 13. Without this the "two failures, one exit code" claim
// rests on an assumption about what a missing `sig` does.
{
  const src = path.join(VECTORS, '001-single-receipt', 'receipts.jsonl')
  const bare = JSON.parse(read(src).trim())
  delete bare.sig
  const target = path.join(tmp, '001-unsigned.jsonl')
  writeFileSync(target, JSON.stringify(bare) + '\n')
  const code = runVerify(target, [
    '--pubkey',
    path.join(VECTORS, 'keys', 'vector-key.pub.pem'),
  ]).code
  if (code !== 13) {
    fail(`control: an otherwise-valid receipt with no sig exited ${code}, expected 13`)
  } else {
    pass('control — a receipt whose only defect is a missing sig exits 13')
  }
}

const orderCases = [
  ['007-schema-invalid', 20, 'schema before hash', false],
  ['003-tampered-field', 10, 'hash before signature', true],
  ['004-prevhash-break', 11, 'prevHash before signature', true],
  ['005-seq-gap', 12, 'seq before signature', true],
]

for (const [name, expected, claim, unsignTheFailingReceipt] of orderCases) {
  const src = path.join(VECTORS, name, 'receipts.jsonl')
  const args = (manifest.cases.find((c) => c.name === name)?.args ?? []).map((a) =>
    a.replace('KEYS/', path.join(VECTORS, 'keys') + path.sep),
  )
  let target = src

  if (unsignTheFailingReceipt) {
    const probe = runVerify(src, args, ['--json'])
    const report = lastJsonLine(probe.out)
    const idx = report && Number.isInteger(report.index) ? report.index : null
    if (idx === null) {
      fail(`check order — ${claim}: could not read the failing index of ${name} from --json`)
      continue
    }
    // `sig` is excluded from the content hash, so removing it moves nothing else.
    const lines = read(src)
      .trim()
      .split('\n')
      .map((l, i) => {
        if (i !== idx) return l
        const r = JSON.parse(l)
        delete r.sig
        return JSON.stringify(r)
      })
    target = path.join(tmp, `${name}-unsigned-${idx}.jsonl`)
    writeFileSync(target, lines.join('\n') + '\n')
    if ('sig' in JSON.parse(lines[idx])) {
      fail(`check order — ${claim}: receipt #${idx} of ${name} still carries a sig`)
      continue
    }
  }

  const actual = runVerify(target, args).code
  if (actual !== expected) {
    fail(`check order — ${claim}: ${name} exited ${actual}, expected ${expected}`)
  } else {
    pass(`check order — ${claim} (${name} -> ${actual})`)
  }
}

// ------------------------------------------------- 3. required-field table
// The spec lists the paths whose absence is a schema error. Reading that list
// off `schemaOk` by eye is how it goes stale, so every row is executed: remove
// exactly that path from the named vector and require exit 20. A row that is
// wrong fails here; a row deleted from the code but left in the table fails too.

function deletePath(obj, dotted) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return false
    cur = cur[parts[i]]
  }
  if (!cur || typeof cur !== 'object' || !(parts.at(-1) in cur)) return false
  delete cur[parts.at(-1)]
  return true
}

const FIELD_SECTION = /### Fields whose absence is a schema error[^\n]*\n([\s\S]*?)(?=\n#{2,4}\s)/
const fieldBlock = specText.match(FIELD_SECTION)
if (!fieldBlock) {
  fail('RECEIPT-SPEC.md has no "Fields whose absence is a schema error" section')
} else {
  const rows = [...fieldBlock[1].matchAll(/^\|\s*`([^`]+)`\s*\|\s*([0-9a-z-]+)\s*\|/gim)]
  if (rows.length === 0) fail('the required-field table in RECEIPT-SPEC.md has no parseable rows')
  let checked = 0
  for (const [, dotted, vector] of rows) {
    const src = path.join(VECTORS, vector, 'receipts.jsonl')
    const lines = read(src).trim().split('\n')
    const first = JSON.parse(lines[0])
    if (!deletePath(first, dotted)) {
      fail(`required-field table: \`${dotted}\` is not present in ${vector} — the row is stale`)
      continue
    }
    lines[0] = JSON.stringify(first)
    const target = path.join(tmp, `req-${vector}-${dotted.replace(/\./g, '_')}.jsonl`)
    writeFileSync(target, lines.join('\n') + '\n')
    const args = (manifest.cases.find((c) => c.name === vector)?.args ?? []).map((a) =>
      a.replace('KEYS/', path.join(VECTORS, 'keys') + path.sep),
    )
    const code = runVerify(target, args).code
    if (code !== 20) {
      fail(`required-field table: removing \`${dotted}\` from ${vector} exited ${code}, expected 20`)
    } else {
      checked++
    }
  }
  if (checked === rows.length) pass(`${checked} documented required fields each produce exit 20`)
}

// ------------------------------------------------------------- 4. case counts
// Two documents said "twelve frozen cases" while the manifest carried thirteen,
// and every test stayed green because each file was consistent with itself.
// Any count written in prose is compared against the manifest from now on.

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
}
const COUNT_RE = new RegExp(
  String.raw`\b(\d+|${Object.keys(WORDS).join('|')})\s+(?:frozen\s+)?cases\b`,
  'gi',
)
const expectedCount = manifest.cases.length
let countsSeen = 0
for (const file of [SPEC, TOP_README, VECTOR_README]) {
  const text = read(file)
  for (const m of text.matchAll(COUNT_RE)) {
    countsSeen++
    const raw = m[1].toLowerCase()
    const value = WORDS[raw] ?? Number(raw)
    if (value !== expectedCount) {
      fail(
        `${path.relative(root, file)} says "${m[0]}" but test-vectors/manifest.json has ${expectedCount}`,
      )
    }
  }
}
if (countsSeen === 0) {
  fail('no prose case count found in the docs — the count regex has gone blind')
} else {
  pass(`${countsSeen} prose case counts agree with the manifest (${expectedCount})`)
}

// --------------------------------------------------- 5. every case documented
// A case added to the manifest but never described is a vector nobody can use;
// a described case that no longer exists is worse.

const tableNames = new Set(
  [...read(VECTOR_README).matchAll(/^\|\s*(\d{3}-[a-z0-9-]+)\s*\|/gim)].map((m) => m[1]),
)
const manifestNames = new Set(manifest.cases.map((c) => c.name))
for (const n of manifestNames) {
  if (!tableNames.has(n)) fail(`case ${n} is in the manifest but not in test-vectors/README.md`)
}
for (const n of tableNames) {
  if (!manifestNames.has(n)) {
    fail(`case ${n} is described in test-vectors/README.md but not in the manifest`)
  }
}
if (manifestNames.size === tableNames.size) pass(`all ${manifestNames.size} cases described`)

// ------------------------------------------------------------ 6. the link works
// The vector README points at the spec section instead of restating it. A
// pointer to a heading that no longer exists is how the restatement comes back.

const LINK_RE = /RECEIPT-SPEC\.md#([a-z0-9-]+)/gi
const slugs = new Set(
  [...specText.matchAll(/^#{2,4}\s+(.+)$/gm)].map(([, h]) =>
    h
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .trim()
      .replace(/\s+/g, '-'),
  ),
)
let linksSeen = 0
for (const file of [VECTOR_README, TOP_README]) {
  for (const m of read(file).matchAll(LINK_RE)) {
    linksSeen++
    if (!slugs.has(m[1])) {
      fail(`${path.relative(root, file)} links to RECEIPT-SPEC.md#${m[1]} — no such heading`)
    }
  }
}
if (linksSeen === 0) {
  fail('test-vectors/README.md no longer points at the spec section — restatement risk')
} else {
  pass(`${linksSeen} spec deep-links resolve`)
}

for (const n of notes) console.log(n)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`)
  console.error(`\nwire contract: ${failures.length} failed`)
  process.exit(1)
}
console.log(`\nwire contract: ${notes.length} checks, all green`)
