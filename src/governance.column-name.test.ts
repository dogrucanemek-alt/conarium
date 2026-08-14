/**
 * G18 — flat query rows must use the same column-name secret/PII heuristic
 * as nested JSON. The older suite passed a whole object to maskPII and
 * hid this split.
 */
import { describe, expect, it } from 'vitest'
import { Governance } from './governance.js'

describe('G18 — column-name mask on the flat redact path', () => {
  const gov = new Governance({ allowTables: ['*'], maxRows: 50 })

  it('redact() masks api_key and password cells by column name', () => {
    const out = gov.redact({
      rows: [{ id: 1, api_key: 'kjh92hf8sdf', password: 'hunter2secret', note: 'ok' }],
      rowCount: 1,
      fields: ['id', 'api_key', 'password', 'note'],
    })
    expect(out.rows[0].api_key).toBe('[MASKED_SECRET]')
    expect(out.rows[0].password).toBe('[MASKED_SECRET]')
    expect(out.rows[0].note).toBe('ok')
    expect(out.rows[0].id).toBe(1)
  })

  it('nested object path is unchanged', () => {
    const r = gov.maskPII({ id: 7, api_key: 'anything-opaque-value', note: 'ok' }) as {
      masked: Record<string, unknown>
    }
    expect(r.masked.api_key).toBe('[MASKED_SECRET]')
    expect(r.masked.note).toBe('ok')
  })
})
