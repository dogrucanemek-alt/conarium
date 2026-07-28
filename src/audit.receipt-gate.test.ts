import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { computeEntryHash, GENESIS_HASH } from './audit-hash.js'
import { writeKeyPairFiles } from './keys.js'

/**
 * GATE 1 / F1 — validateChain must not treat legacy (no sig) or rotated (other keyId)
 * entries as tampering. Only a bad signature under the *current* keyId is corruption.
 */
describe('audit validateChain — Ed25519 scope (F1)', () => {
  const prevEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ['CONARIUM_AUDIT_UNSIGNED', 'CONARIUM_AUDIT_HMAC_KEY', 'CONARIUM_AUDIT_SIGNING_KEY', 'CONARIUM_AUDIT_KEY_ID']) {
      prevEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function writeUnsignedEntry(sink: string, tool: string, prevHash: string): string {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      actor: 'legacy',
      tool,
      denied: false,
      prevHash,
    }
    entry.hash = computeEntryHash(entry)
    appendFileSync(sink, JSON.stringify(entry) + '\n')
    return entry.hash as string
  }

  it('accepts pre-Ed25519 sink (sig yok) when current Ed25519 key is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-f1-nosig-'))
    const sink = join(dir, 'audit.jsonl')
    writeFileSync(sink, '')
    const h0 = writeUnsignedEntry(sink, 't1', GENESIS_HASH)
    writeUnsignedEntry(sink, 't2', h0)

    const { privatePath } = writeKeyPairFiles(join(dir, 'cnr-now'), 'cnr-now')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath

    expect(() => new Audit({ sink, consumer: 'boot' })).not.toThrow()
    // New writes still get signed with the current key
    const audit = new Audit({ sink, consumer: 'boot' })
    const entry = audit.log({ tool: 't3', denied: false })
    expect(entry.sig?.keyId).toBe('cnr-now')
  })

  it('accepts rotated keyId entries (foreign keyId) without treating as tampering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-f1-rotate-'))
    const oldPair = writeKeyPairFiles(join(dir, 'cnr-old'), 'cnr-old')
    const newPair = writeKeyPairFiles(join(dir, 'cnr-new'), 'cnr-new')

    process.env.CONARIUM_AUDIT_SIGNING_KEY = oldPair.privatePath
    const sink = join(dir, 'audit.jsonl')
    const a = new Audit({ sink, consumer: 'old' })
    a.log({ tool: 't1', denied: false })

    // Switch to new key — validateChain must accept old-keyId lines
    process.env.CONARIUM_AUDIT_SIGNING_KEY = newPair.privatePath
    expect(() => new Audit({ sink, consumer: 'new' })).not.toThrow()
    const b = new Audit({ sink, consumer: 'new' })
    const entry = b.log({ tool: 't2', denied: false })
    expect(entry.sig?.keyId).toBe('cnr-new')

    const lines = readFileSync(sink, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0].sig.keyId).toBe('cnr-old')
    expect(lines[1].sig.keyId).toBe('cnr-new')
  })

  it('still rejects a bad signature when keyId matches current key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-f1-bad-'))
    const { privatePath } = writeKeyPairFiles(join(dir, 'cnr-now'), 'cnr-now')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath
    const sink = join(dir, 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'x' })
    audit.log({ tool: 't1', denied: false })

    // Tamper sig.value while keeping keyId
    const lines = readFileSync(sink, 'utf-8').trim().split('\n')
    const entry = JSON.parse(lines[0])
    entry.sig.value = Buffer.from('not-a-real-signature-bytes!!').toString('base64')
    // sig is excluded from hash, so hash still matches — only sig check should fire
    writeFileSync(sink, JSON.stringify(entry) + '\n')

    expect(() => new Audit({ sink, consumer: 'x' })).toThrow(/Ed25519 signature mismatch/)
  })

  it('card numbers still mask as MASKED_PII not MASKED_SECRET (F2 regression)', () => {
    process.env.CONARIUM_AUDIT_UNSIGNED = '1'
    const sink = join(mkdtempSync(join(tmpdir(), 'cnr-f2-')), 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'test' })
    audit.log({
      tool: 'query',
      denied: false,
      args: { card: '4111 1111 1111 1111' },
    })
    const content = readFileSync(sink, 'utf-8')
    expect(content).not.toContain('4111 1111 1111 1111')
    expect(content).toContain('[MASKED_PII]')
    expect(content).not.toMatch(/4111.*"\[MASKED_SECRET\]"|\[MASKED_SECRET\].*4111/)
  })
})
