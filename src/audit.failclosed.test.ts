import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { createPlaygroundAudit } from './console.js'

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
