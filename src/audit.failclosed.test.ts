import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { createPlaygroundAudit } from './console.js'

// These suites exercise sink/chain behaviour, not signing. Opt into unsigned mode
// so fail-closed signing (Receipt v0.1) does not mask the assertions under test.
const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => {
  process.env.CONARIUM_AUDIT_UNSIGNED = '1'
})
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

// Regression: Codex denetimi 2026-07-06 P2 — audit failClosed defaulted to false,
// so a broken sink silently dropped the trail while docs promised append-always.
describe('audit fail-closed default', () => {
  it('throws by default when the sink cannot be written', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'conarium-audit-')), 'missing-dir', 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'test' })
    expect(() => audit.log({ tool: 'query_db', denied: false })).toThrow(/Audit sink write failed/)
  })

  it('can still opt out explicitly for throwaway setups', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'conarium-audit-')), 'missing-dir', 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'test', failClosed: false })
    expect(() => audit.log({ tool: 'query_db', denied: false })).not.toThrow()
  })

  it('log() returns the full hashed entry', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'conarium-audit-')), 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'test' })
    const entry = audit.log({ tool: 'query_db', denied: false })
    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(entry.actor).toBe('test')
  })

  it('refuses unsigned log when CONARIUM_AUDIT_UNSIGNED is unset', () => {
    const saved = process.env.CONARIUM_AUDIT_UNSIGNED
    delete process.env.CONARIUM_AUDIT_UNSIGNED
    delete process.env.CONARIUM_AUDIT_HMAC_KEY
    delete process.env.CONARIUM_AUDIT_SIGNING_KEY
    try {
      const sink = join(mkdtempSync(join(tmpdir(), 'conarium-audit-')), 'audit.jsonl')
      const audit = new Audit({ sink, consumer: 'test' })
      expect(() => audit.log({ tool: 'query_db', denied: false })).toThrow(/refusing to write unsigned/)
    } finally {
      if (saved === undefined) process.env.CONARIUM_AUDIT_UNSIGNED = '1'
      else process.env.CONARIUM_AUDIT_UNSIGNED = saved
    }
  })
})

// Regression: console playground wrote raw unhashed JSON lines next to (or into)
// the hash-chained audit — entries outside the chain read as tampering.
describe('console playground audit chain', () => {
  it('chains playground entries so a fresh Audit accepts the sink', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'conarium-console-')), 'audit.jsonl')
    const audit = createPlaygroundAudit(sink)
    audit.log({ tool: 'query_db', target: 'public.customers', denied: false })
    audit.log({ tool: 'query_db', target: 'public.orders', denied: true, reason: 'test' })

    const lines = readFileSync(sink, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[1].prevHash).toBe(lines[0].hash)
    expect(() => new Audit({ sink })).not.toThrow()
  })

  it('rotates a legacy unhashed sink aside instead of corrupting the chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-console-'))
    const sink = join(dir, 'audit.jsonl')
    writeFileSync(sink, JSON.stringify({ actor: 'legacy', tool: 'query_db' }) + '\n')

    const audit = createPlaygroundAudit(sink)
    const entry = audit.log({ tool: 'query_db', denied: false })
    expect(entry.prevHash).toBe('0'.repeat(64))
    expect(() => new Audit({ sink })).not.toThrow()
  })

  it('does NOT rotate a tampered chain — hashed entries that fail validation stay a hard error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-console-'))
    const sink = join(dir, 'audit.jsonl')
    writeFileSync(sink, JSON.stringify({
      actor: 'attacker', tool: 'query_db', denied: false,
      prevHash: '0'.repeat(64), hash: 'f'.repeat(64),
    }) + '\n')

    expect(() => createPlaygroundAudit(sink)).toThrow(/corrupt/)
    expect(readFileSync(sink, 'utf-8')).toContain('attacker')
  })
})
