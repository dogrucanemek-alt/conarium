/**
 * test/coverage_cli.test.mjs
 *
 * CLI davranış testleri — conarium-coverage alt süreç olarak çalıştırılır.
 * Desen: verify_actor.test.mjs (vitest + execFileSync + el yazısı fixture).
 * ZERO imports from src/ — canonicalize/coverageHash bin dosyasından import edilir
 * (bin zaten JCS subset'i kendi içinde taşıyor; imza üretimi için aynı hash gerekir).
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const COVERAGE = fileURLToPath(new URL('../bin/conarium-coverage.mjs', import.meta.url))
const { canonicalize, coverageHash } = await import(COVERAGE)

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cnr-cov-'))
}

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

/** İmzalı, şema-geçerli bir coverage beyanı üret. */
function signedDeclaration(keys, overrides = {}) {
  const body = {
    v: 'conarium-coverage/0.2',
    id: 'test-cov-001',
    ts: '2026-07-31T12:00:00.000Z',
    period: { start: '2026-07-31T11:00:00.000Z', end: '2026-07-31T12:00:00.000Z' },
    declaredScope: ['public.customers'],
    chain: { firstSeq: 1, lastSeq: 3, count: 3, contiguous: true, gaps: [] },
    decisions: { allow: 3, partial: 0, deny: 0 },
    coverage: {
      declared: 1,
      accessed: 1,
      notRecorded: 0,
      accessedObjects: ['public.customers'],
      notRecordedObjects: [],
      unassignedReceiptCount: 0,
    },
    ...overrides,
  }
  const hash = coverageHash(body)
  const sigValue = sign(null, Buffer.from(hash, 'utf-8'), keys.privateKey).toString('base64')
  return { ...body, sig: { alg: 'Ed25519', keyId: keys.keyId, value: sigValue } }
}

function runCoverage(declPath, pubkeyPath, extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, [
      COVERAGE,
      declPath,
      '--pubkey',
      pubkeyPath,
      ...extraArgs,
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('conarium-coverage CLI chain-gap behavior', () => {
  it('kesintisiz beyan → exit 0 (regresyon)', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const decl = signedDeclaration(keys)
    const path = join(dir, 'decl.json')
    writeJSON(path, decl)
    const result = runCoverage(path, keys.pubPath)
    if (result.code !== 0) {
      console.error('stderr:', result.stderr)
      console.error('stdout:', result.stdout)
    }
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/contiguous=true/)
  })

  it('boşluklu beyan, bayraksız → exit 12', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const decl = signedDeclaration(keys, {
      chain: { firstSeq: 1, lastSeq: 3, count: 2, contiguous: false, gaps: [{ expectedSeq: 2, foundSeq: 3 }] },
      decisions: { allow: 2, partial: 0, deny: 0 },
    })
    const path = join(dir, 'decl.json')
    writeJSON(path, decl)
    const result = runCoverage(path, keys.pubPath)
    if (result.code !== 12) {
      console.error('stderr:', result.stderr)
      console.error('stdout:', result.stdout)
    }
    expect(result.code).toBe(12)
    expect(result.stderr).toMatch(/NOT contiguous/)
    expect(result.stderr).toMatch(/seq 2/)
  })

  it('boşluklu beyan + --allow-gaps → exit 0', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const decl = signedDeclaration(keys, {
      chain: { firstSeq: 1, lastSeq: 3, count: 2, contiguous: false, gaps: [{ expectedSeq: 2, foundSeq: 3 }] },
      decisions: { allow: 2, partial: 0, deny: 0 },
    })
    const path = join(dir, 'decl.json')
    writeJSON(path, decl)
    const result = runCoverage(path, keys.pubPath, ['--allow-gaps'])
    if (result.code !== 0) {
      console.error('stderr:', result.stderr)
      console.error('stdout:', result.stdout)
    }
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/contiguous=false/)
  })

  it('G21: --receipts with a broken Ed25519 sig is not complete', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const receipt = {
      id: 'r-bad-sig',
      chain: { seq: 1, prevHash: 'sha256:' + '00'.repeat(32), hash: 'sha256:' + 'ab'.repeat(32) },
      policy: { decision: 'allow' },
      dataRefs: [{ object: 'public.customers' }],
      request: { tool: 'query', target: 'public.customers' },
      sig: { alg: 'Ed25519', keyId: keys.keyId, value: Buffer.from('not-a-sig').toString('base64') },
    }
    const decl = signedDeclaration(keys, {
      chain: { firstSeq: 1, lastSeq: 1, count: 1, contiguous: true, gaps: [] },
      decisions: { allow: 1, partial: 0, deny: 0 },
    })
    const declPath = join(dir, 'decl.json')
    const recPath = join(dir, 'receipts.jsonl')
    writeJSON(declPath, decl)
    writeFileSync(recPath, JSON.stringify(receipt) + '\n')
    const result = runCoverage(declPath, keys.pubPath, ['--receipts', recPath])
    expect(result.code).not.toBe(0)
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/r-bad-sig/)
    expect(`${result.stderr}\n${result.stdout}`).not.toMatch(/^ok:/m)
  })

  it('G21: output never claims no access occurred', () => {
    const dir = tmpDir()
    const keys = writeKeyPair(dir)
    const decl = signedDeclaration(keys, {
      coverage: {
        declared: 2,
        accessed: 1,
        notRecorded: 1,
        accessedObjects: ['public.customers'],
        notRecordedObjects: ['public.orders'],
        unassignedReceiptCount: 0,
      },
      declaredScope: ['public.customers', 'public.orders'],
    })
    const path = join(dir, 'decl.json')
    writeJSON(path, decl)
    const result = runCoverage(path, keys.pubPath)
    expect(result.code).toBe(0)
    const text = `${result.stdout}\n${result.stderr}`
    expect(text).toMatch(/notRecorded|NOT RECORDED/)
    expect(text).not.toMatch(/no access occurred/i)
    expect(text).not.toMatch(/erişim olmadı/i)
    expect(text).toMatch(/start not pinned|window start not pinned|başlangıç sabitlenmedi/i)
  })
})
