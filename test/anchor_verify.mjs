/**
 * A6.5–A6.7 — conarium-verify --anchor-check with TESTOTS stubs (no calendar).
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createPrivateKey } from 'crypto'
import assert from 'assert'
import { buildReceipt, nextChainState, hashArgs } from '../dist/receipt.js'
import { generateKeyPair, writeKeyPairFiles } from '../dist/keys.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERIFY = join(ROOT, 'bin', 'conarium-verify.mjs')

function runVerify(args) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' }
}

function stubOts(kind) {
  return Buffer.from(`TESTOTS:${kind}`, 'utf8').toString('base64')
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-av-'))
  const { privatePath, publicPath } = writeKeyPairFiles(join(dir, 'cnr-av'), 'cnr-av')
  process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath
  const key = {
    keyId: 'cnr-av',
    privateKey: createPrivateKey(
      (await import('fs')).readFileSync(privatePath, 'utf-8'),
    ),
  }

  const input = {
    period: { start: '2026-07-29T00:00:00.000Z', end: '2026-07-29T00:00:01.000Z' },
    actor: { id: 'svc' },
    model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
    client: { name: 'cursor', version: '2.x' },
    request: { tool: 'query', target: 'demo-db', argsHash: hashArgs({ q: 1 }) },
    dataRefs: [{ source: 'demo', object: 't', fieldsRequested: ['a'] }],
    policy: { id: 'p', version: '1', decision: 'allow', rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
  }

  const r0 = buildReceipt(input, nextChainState(null), key)
  const chainPath = join(dir, 'chain.jsonl')
  const anchorsPath = `${chainPath}.anchors.jsonl`

  // A6.5 — anchor stripped
  writeFileSync(chainPath, JSON.stringify({ ...r0, anchor: null }) + '\n')
  let res = runVerify([chainPath, '--pubkey', publicPath, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.5 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor missing/)

  // A6.6 — pending stub → 0 + warning
  const pendingRow = {
    seq: r0.chain.seq,
    hash: r0.chain.hash,
    log: 'opentimestamps',
    ots: stubOts('pending'),
    state: 'pending',
    submittedAt: new Date().toISOString(),
    upgradedAt: null,
    bitcoinBlock: null,
  }
  writeFileSync(
    chainPath,
    JSON.stringify({
      ...r0,
      anchor: { log: 'opentimestamps', ref: r0.chain.hash, state: 'pending' },
    }) + '\n',
  )
  writeFileSync(anchorsPath, JSON.stringify(pendingRow) + '\n')
  res = runVerify([chainPath, '--pubkey', publicPath, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 0, `A6.6 expected 0, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor pending/)

  // A6.7 — ots stub says mismatch
  writeFileSync(
    anchorsPath,
    JSON.stringify({ ...pendingRow, ots: stubOts('mismatch') }) + '\n',
  )
  res = runVerify([chainPath, '--pubkey', publicPath, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.7 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor proof failed|does not match/)

  console.log('anchor-verify tests OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
