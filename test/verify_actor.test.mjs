/**
 * test/verify_actor.test.mjs
 *
 * Actor/assurance schema tests for conarium-verify.
 * ZERO imports from src/ — fixtures are hand-written JSON.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const VERIFIER = fileURLToPath(new URL('../bin/conarium-verify.mjs', import.meta.url))

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cnr-verify-'))
}

/**
 * JSONL yaz — satir basina BIR makbuz.
 * Dogrulayici dosyayi satir bazli okuyor; suslu yazdirmada ilk satir yalnizca
 * '{' olur ve JSON.parse('{') "position 1" hatasi verir. Hata BOM ya da kisa
 * yol meselesi degildi, bicim meselesiydi.
 */
function writeJSON(path, obj) {
  writeFileSync(path, JSON.stringify(obj) + '\n')
}

function writeKeyPair(dir) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const pubPath = join(dir, 'test.pub.pem')
  writeFileSync(pubPath, publicKey)
  const keyId = `test-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`
  writeFileSync(pubPath + '.keyid', keyId)
  return { pubPath, keyId, privateKey }
}

function runVerify(receiptPath, pubkeyPath) {
  try {
    const stdout = execFileSync(process.execPath, [
      VERIFIER,
      receiptPath,
      '--pubkey',
      pubkeyPath,
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

// ─── v0.2 base receipt (valid schema) ────────────────────────────────────────

function v2Receipt(overrides = {}) {
  return {
    v: 'conarium-receipt/0.2',
    id: 'test-001',
    ts: '2026-07-31T12:00:00.000Z',
    period: { start: '2026-07-31T11:00:00.000Z', end: '2026-07-31T12:00:00.000Z' },
    actor: { type: 'user', id: 'ayse@x.com', assurance: 'per-user-token' },
    model: { provider: 'openai', name: 'gpt-4', version: '1.0' },
    client: { name: 'conarium', version: '0.2.0' },
    request: { tool: 'chat', target: 'gpt-4', argsHash: 'sha256:abc' },
    dataRefs: [],
    policy: { id: 'default', version: '1', decision: 'allow', rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
    consentRef: null,
    chain: { seq: 1, prevHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    sig: null,
    anchor: null,
    ...overrides,
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('conarium-verify actor schema', () => {
  it('(a) v0.2 + user + per-user-token → schema valid (exit 0)', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const rcp = v2Receipt()
    const path = join(dir, 'receipt.json')
    writeJSON(path, rcp)
    const result = runVerify(path, keys.pubPath)
    if (result.code !== 13 && result.code !== 0) {
      console.error('(a) stderr:', result.stderr)
      console.error('(a) stdout:', result.stdout)
    }
    // Schema valid → not 20. Sig null → 13.
    expect(result.code).not.toBe(20)
  })

  it('(b) v0.2 + user + shared-token → exit 20', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const rcp = v2Receipt({
      actor: { type: 'user', id: 'ayse@x.com', assurance: 'shared-token' },
    })
    const path = join(dir, 'receipt.json')
    writeJSON(path, rcp)
    const result = runVerify(path, keys.pubPath)
    if (result.code !== 20) {
      console.error('(b) stderr:', result.stderr)
      console.error('(b) stdout:', result.stdout)
    }
    expect(result.code).toBe(20)
  })

  it('(c) v0.2 + service + no assurance → exit 20', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const rcp = v2Receipt({
      actor: { type: 'service', id: 'svc-1' },
    })
    delete rcp.actor.assurance
    const path = join(dir, 'receipt.json')
    writeJSON(path, rcp)
    const result = runVerify(path, keys.pubPath)
    if (result.code !== 20) {
      console.error('(c) stderr:', result.stderr)
      console.error('(c) stdout:', result.stdout)
    }
    expect(result.code).toBe(20)
  })

  it('(d) v0.1 + service → schema valid (backward compat)', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const rcp = v2Receipt({
      v: 'conarium-receipt/0.1',
      actor: { type: 'service', id: 'svc-1' },
    })
    delete rcp.actor.assurance
    const path = join(dir, 'receipt.json')
    writeJSON(path, rcp)
    const result = runVerify(path, keys.pubPath)
    expect(result.code).not.toBe(20)
  })
})
