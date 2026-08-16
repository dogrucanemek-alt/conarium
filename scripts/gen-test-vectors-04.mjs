#!/usr/bin/env node
/**
 * Append 0.4 conformance vectors. Does NOT rewrite 001–012.
 * 010–012 were written by an earlier revision of this file and are frozen.
 * This revision only adds 013 and merges the manifest.
 *
 * Usage: npm run build && node scripts/gen-test-vectors-04.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createPrivateKey } from 'crypto'
import { buildReceipt, RECEIPT_GENESIS_HASH, receiptHash } from '../dist/receipt.js'
import { signHash } from '../dist/keys.js'

const ROOT = 'test-vectors'
const KEY_DIR = join(ROOT, 'keys')
const KEY_ID = 'cnr-vectors'
const PRIV = join(KEY_DIR, 'vector-key.SECRET-TEST-ONLY.pem')

if (!existsSync(join(ROOT, '010-disclosure-commitment', 'receipts.jsonl'))) {
  throw new Error('010–012 missing — this script no longer creates them')
}
if (existsSync(join(ROOT, '013-disclosure-keys-omitted', 'receipts.jsonl'))) {
  throw new Error('013 already exists — refusing to overwrite a frozen vector')
}

const privatePem = readFileSync(PRIV, 'utf-8').replace(/^#[^\n]*\n/gm, '')
const key = { keyId: KEY_ID, privateKey: createPrivateKey(privatePem) }

function input04(n, overrides = {}) {
  return {
    id: `01JVECTOR00000000000000${String(n).padStart(3, '0')}`,
    ts: `2026-08-16T00:00:0${n}.000Z`,
    period: { start: `2026-08-16T00:00:0${n}.000Z`, end: `2026-08-16T00:00:0${n}.500Z` },
    actor: { id: 'vector-service', type: 'service', assurance: 'shared-token' },
    request: {
      tool: 'query',
      target: 'demo-db',
      argsHash: `sha256:${'ab'.repeat(32)}`,
    },
    dataRefs: [{ source: 'vectors', object: 'public.demo', fieldsRequested: ['id'] }],
    policy: {
      id: 'conarium.policy/vectors',
      version: '1',
      decision: 'allow',
      rulesApplied: ['mask:name'],
    },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 1, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
    ...overrides,
  }
}

const line = (r) => JSON.stringify(r) + '\n'

// Signed with hash/bytes omitted — not stripped after the fact. Otherwise the
// stored hash would fail first (exit 10) and the schema split would stay hidden.
const r013 = buildReceipt(input04(13), { seq: 1, prevHash: RECEIPT_GENESIS_HASH }, key)
if (r013.v !== 'conarium-receipt/0.4') throw new Error(`expected 0.4, got ${r013.v}`)
if (r013.disclosure.source !== 'undeclared' || r013.disclosure.hash !== null || r013.disclosure.bytes !== null) {
  throw new Error('013 base must be undeclared with explicit nulls before keys are omitted')
}
delete r013.disclosure.hash
delete r013.disclosure.bytes
if ('hash' in r013.disclosure || 'bytes' in r013.disclosure) {
  throw new Error('013 must omit disclosure.hash and disclosure.bytes')
}
const hash013 = receiptHash(r013)
r013.chain.hash = hash013
r013.sig = { alg: 'Ed25519', keyId: KEY_ID, value: signHash(key, hash013) }

const cases = [
  {
    name: '013-disclosure-keys-omitted',
    description:
      '0.4 receipt whose disclosure is undeclared but omits hash and bytes entirely. Absence is not explicit null; verify exits 20.',
    exitCode: 20,
    args: ['--pubkey', 'KEYS/vector-key.pub.pem'],
    body: line(r013),
  },
]

for (const c of cases) {
  const dir = join(ROOT, c.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipts.jsonl'), c.body)
  console.log(`  ${c.name} -> exit ${c.exitCode}  ${hash013}`)
}

const manifestPath = join(ROOT, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const existing = new Set(manifest.cases.map((c) => c.name))
for (const c of cases) {
  if (existing.has(c.name)) throw new Error(`manifest already has ${c.name}`)
  manifest.cases.push({
    name: c.name,
    description: c.description,
    exitCode: c.exitCode,
    args: c.args,
  })
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const hashesPath = join(ROOT, 'expected-hashes.json')
const hashes = JSON.parse(readFileSync(hashesPath, 'utf-8'))
hashes.receipts.push({
  case: '013-disclosure-keys-omitted',
  seq: 1,
  prevHash: r013.chain.prevHash,
  hash: r013.chain.hash,
})
writeFileSync(hashesPath, JSON.stringify(hashes, null, 2) + '\n')

console.log('013 written. 001–012 untouched.')
