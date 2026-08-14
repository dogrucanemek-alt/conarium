/**
 * G16 — reason/target/governance go through the same mask pipeline as args.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Audit } from './audit.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

const EMAIL = 'alice@example.com'
const TCKN = '12345678901'

describe('G16 — audit masks reason/target/governance', () => {
  it('reason with email and TCKN is masked in the sink', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'conarium-g16-')), 'audit.jsonl')
    const audit = new Audit({ sink, consumer: 'g16' })
    audit.log({
      tool: 'query',
      denied: true,
      reason: `invalid input syntax for type integer: "${EMAIL}" (tckn ${TCKN})`,
      target: `notes about ${EMAIL}`,
      governance: { denyReason: `cast failed: ${EMAIL}` },
    })
    const raw = readFileSync(sink, 'utf8')
    expect(raw).not.toContain(EMAIL)
    expect(raw).not.toContain(TCKN)
    expect(raw).toMatch(/MASKED/)
    const row = JSON.parse(raw.trim())
    expect(row.reason).toMatch(/MASKED/)
    expect(row.target).toMatch(/MASKED/)
    expect(JSON.stringify(row.governance)).toMatch(/MASKED/)
  })
})
