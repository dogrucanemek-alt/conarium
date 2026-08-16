#!/usr/bin/env node
/**
 * Append 0.4 conformance vectors. Does NOT rewrite 001–009.
 * Frozen cases stay frozen; this file only adds 010–012 and merges the manifest.
 *
 * Usage: npm run build && node scripts/gen-test-vectors-04.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createPrivateKey } from 'crypto'
import { buildReceipt, RECEIPT_GENESIS_HASH, hashDisclosure } from '../dist/receipt.js'

const ROOT = 'test-vectors'
const KEY_DIR = join(ROOT, 'keys')
const KEY_ID = 'cnr-vectors'
const PRIV = join(KEY_DIR, 'vector-key.SECRET-TEST-ONLY.pem')

if (!existsSync(join(ROOT, '001-single-receipt', 'receipts.jsonl'))) {
  throw new Error('001-single-receipt missing — do not invent a new 0.3 chain here')
}
if (existsSync(join(ROOT, '010-disclosure-commitment', 'receipts.jsonl'))) {
  throw new Error('010 already exists — refusing to overwrite a frozen vector')
}

const privatePem = readFileSync(PRIV, 'utf-8').replace(/^#[^\n]*\n/gm, '')
const key = { keyId: KEY_ID, privateKey: createPrivateKey(privatePem) }

const payload = JSON.stringify(
  {
    rowCount: 1,
    fields: [{ name: 'id' }],
    rows: [{ id: 1 }],
    truncated: false,
  },
  null,
  2,
)
const disc = hashDisclosure(payload)

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

const r010 = buildReceipt(
  input04(10, { disclosurePayload: payload }),
  { seq: 1, prevHash: RECEIPT_GENESIS_HASH },
  key,
)
if (r010.v !== 'conarium-receipt/0.4') throw new Error(`expected 0.4, got ${r010.v}`)
if (r010.disclosure.source !== 'measured' || r010.disclosure.hash !== disc.hash) {
  throw new Error('010 disclosure hash mismatch')
}

const r011 = buildReceipt(
  input04(11, { destination: 'openai/gpt-x' }),
  { seq: 1, prevHash: RECEIPT_GENESIS_HASH },
  key,
)
if (r011.destination.source !== 'operator-declared' || r011.destination.value !== 'openai/gpt-x') {
  throw new Error('011 destination not operator-declared')
}

const frozen001 = JSON.parse(readFileSync(join(ROOT, '001-single-receipt', 'receipts.jsonl'), 'utf-8').trim())
if (frozen001.v !== 'conarium-receipt/0.3') throw new Error('001 is no longer 0.3 — mixed-chain vector is invalid')
const r012 = buildReceipt(
  input04(12, { disclosurePayload: payload, destination: 'openai/gpt-x' }),
  { seq: 2, prevHash: frozen001.chain.hash },
  key,
)

const cases = [
  {
    name: '010-disclosure-commitment',
    description: '0.4 receipt with a measured disclosure hash over the masked, row-capped payload. Verify exits 0.',
    exitCode: 0,
    args: ['--pubkey', 'KEYS/vector-key.pub.pem'],
    body: line(r010),
  },
  {
    name: '011-destination-declared',
    description: '0.4 receipt with destination declared by the operator. source is operator-declared, not verified.',
    exitCode: 0,
    args: ['--pubkey', 'KEYS/vector-key.pub.pem'],
    body: line(r011),
  },
  {
    name: '012-mixed-chain',
    description: 'A 0.3 receipt followed by a 0.4 receipt. The chain verifies; old receipts are not rewritten.',
    exitCode: 0,
    args: ['--pubkey', 'KEYS/vector-key.pub.pem'],
    body: line(frozen001) + line(r012),
  },
]

for (const c of cases) {
  const dir = join(ROOT, c.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipts.jsonl'), c.body)
  console.log(`  ${c.name} -> exit ${c.exitCode}  ${c.name === '012-mixed-chain' ? r012.chain.hash : ''}`)
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
manifest.versionUnderTest = 'conarium-receipt/0.4'
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const hashesPath = join(ROOT, 'expected-hashes.json')
const hashes = JSON.parse(readFileSync(hashesPath, 'utf-8'))
hashes.receipts.push(
  { case: '010-disclosure-commitment', seq: 1, prevHash: r010.chain.prevHash, hash: r010.chain.hash },
  { case: '011-destination-declared', seq: 1, prevHash: r011.chain.prevHash, hash: r011.chain.hash },
  { case: '012-mixed-chain', seq: 2, prevHash: r012.chain.prevHash, hash: r012.chain.hash },
)
writeFileSync(hashesPath, JSON.stringify(hashes, null, 2) + '\n')

console.log('010–012 written. 001–009 untouched.')
