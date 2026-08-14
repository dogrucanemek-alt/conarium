/**
 * G1/G2 — lastHash/sinkSize must advance only after a successful append.
 * The sink is made read-only (chmod 0444) so appendFileSync throws EPERM
 * without mocking Node's non-configurable `fs` bindings.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { GENESIS_HASH } from './audit-hash.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

function sinkPath() {
  return join(mkdtempSync(join(tmpdir(), 'conarium-g1-')), 'audit.jsonl')
}

function lines(sink: string) {
  const raw = readFileSync(sink, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((l) => JSON.parse(l) as { hash: string; prevHash: string; tool: string })
}

describe('G1 — audit chain atomicity', () => {
  it('failed append (failClosed=false) does not become the next prevHash', () => {
    const sink = sinkPath()
    writeFileSync(sink, '')
    const audit = new Audit({ sink, consumer: 'g1', failClosed: false })
    chmodSync(sink, 0o444)
    audit.log({ tool: 't1', denied: false })
    chmodSync(sink, 0o666)
    audit.log({ tool: 't2', denied: false })
    const rows = lines(sink)
    expect(rows).toHaveLength(1)
    expect(rows[0].prevHash).toBe(GENESIS_HASH)
    expect(rows[0].tool).toBe('t2')
    expect(() => new Audit({ sink })).not.toThrow()
  })
})

describe('G2 — self-heal after a write failure', () => {
  it('next successful log + fresh Audit validateChain after a failed append', () => {
    const sink = sinkPath()
    const audit = new Audit({ sink, consumer: 'g2', failClosed: false })
    audit.log({ tool: 'ok', denied: false })
    const first = lines(sink)[0]
    chmodSync(sink, 0o444)
    audit.log({ tool: 'fail', denied: false })
    chmodSync(sink, 0o666)
    audit.log({ tool: 'ok2', denied: false })
    const rows = lines(sink)
    expect(rows).toHaveLength(2)
    expect(rows[1].prevHash).toBe(first.hash)
    expect(rows[1].tool).toBe('ok2')
    expect(() => new Audit({ sink })).not.toThrow()
  })

  it('failClosed=true throw does not advance lastHash', () => {
    const sink = sinkPath()
    writeFileSync(sink, '')
    const audit = new Audit({ sink, consumer: 'g2', failClosed: true })
    chmodSync(sink, 0o444)
    expect(() => audit.log({ tool: 'fail', denied: false })).toThrow(/Audit sink write failed/)
    chmodSync(sink, 0o666)
    audit.log({ tool: 'ok', denied: false })
    const rows = lines(sink)
    expect(rows).toHaveLength(1)
    expect(rows[0].prevHash).toBe(GENESIS_HASH)
    expect(() => new Audit({ sink })).not.toThrow()
  })
})
