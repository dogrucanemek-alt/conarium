/**
 * Own-key writes — a `__proto__` field must stay a field.
 *
 * `obj["__proto__"] = v` does not create an own property. It changes the
 * prototype and the key disappears. These tests lock the desired behaviour
 * (field present, prototype untouched) so a silent drop cannot ship.
 */
import { describe, expect, it } from 'vitest'
import { Governance } from './governance.js'
import { redactSecretFields } from './console.js'
import { maskSplitTcknFields } from './tckn.js'
import { hashDisclosure } from './receipt.js'

function rowWithProto(extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Computed `__proto__` is an own key. The identifier form is the prototype setter.
  return JSON.parse(JSON.stringify({ ...extra, ['__proto__']: 'keep-me' }))
}

function ownProto(obj: object): boolean {
  return Object.prototype.hasOwnProperty.call(obj, '__proto__')
}

describe('own-key: governance.redact', () => {
  const gov = new Governance({
    allowTables: ['*'],
    maskColumns: ['email'],
    maxRows: 50,
  })

  it('keeps a literal __proto__ column and does not change the row prototype', () => {
    const input = rowWithProto({ email: 'a@b.com', id: 1 })
    expect(ownProto(input)).toBe(true)

    const out = gov.redact(
      { rows: [input], rowCount: 1, fields: ['__proto__', 'email', 'id'] } as never,
      {},
      undefined,
    ).rows[0]

    expect(ownProto(out)).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { __proto__: unknown })['__proto__']).toBe('keep-me')
    expect(out.email).toBe('[MASKED_PII]')
    expect(out.id).toBe(1)
  })

  it('when the __proto__ column itself is masked, the field stays and the value is masked', () => {
    const govMaskProto = new Governance({
      allowTables: ['*'],
      maskColumns: ['__proto__'],
      maxRows: 50,
    })
    const input = rowWithProto({ id: 1 })
    const out = govMaskProto.redact(
      { rows: [input], rowCount: 1, fields: ['__proto__', 'id'] } as never,
      {},
      undefined,
    ).rows[0]

    expect(ownProto(out)).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { __proto__: unknown })['__proto__']).toBe('[MASKED_PII]')
  })

  it('nested maskPII keeps a literal __proto__ key', () => {
    const nested = JSON.parse('{"__proto__":{"note":"ok"},"email":"a@b.com"}')
    const r = gov.maskPII(nested) as { masked: Record<string, unknown> }
    expect(ownProto(r.masked)).toBe(true)
    expect(Object.getPrototypeOf(r.masked)).toBe(Object.prototype)
  })
})

describe('own-key: console redactSecretFields', () => {
  it('keeps a literal __proto__ key and does not change the prototype', () => {
    const input = JSON.parse('{"__proto__":"visible","token":"s3cret","note":"ok"}')
    const out = redactSecretFields(input) as Record<string, unknown>
    expect(ownProto(out)).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out['__proto__']).toBe('visible')
    expect(out.token).toBe('[REDACTED]')
    expect(out.note).toBe('ok')
  })
})

describe('own-key: tckn split mask', () => {
  it('masking split TCKN fields does not drop a sibling __proto__ key or pollute the prototype', () => {
    const row = JSON.parse(
      JSON.stringify({ ['__proto__']: 'keep-me', tckn_1: '10000', tckn_2: '000146' }),
    )
    const r = maskSplitTcknFields(row)
    expect(r.count).toBe(2)
    expect(row.tckn_1).toBe('[MASKED_PII]')
    expect(row.tckn_2).toBe('[MASKED_PII]')
    expect(ownProto(row)).toBe(true)
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(row['__proto__']).toBe('keep-me')
  })
})

describe('own-key: disclosure hash vs gateway bytes', () => {
  it('the hashed payload and the returned rows agree on whether __proto__ is present', () => {
    const gov = new Governance({
      allowTables: ['*'],
      maskColumns: ['email'],
      maxRows: 50,
    })
    const input = rowWithProto({ email: 'a@b.com' })
    const result = gov.redact(
      { rows: [input], rowCount: 1, fields: ['__proto__', 'email'] } as never,
      {},
      undefined,
    )
    const responseJson = JSON.stringify(
      {
        rowCount: result.rowCount,
        fields: ['__proto__', 'email'],
        rows: result.rows,
        truncated: false,
      },
      null,
      2,
    )
    const inRow = ownProto(result.rows[0] as object)
    const inJson = /"__proto__"\s*:/.test(responseJson)
    expect(inJson).toBe(inRow)
    hashDisclosure(responseJson)
  })

  it('a normal row without __proto__ keeps the same bytes and disclosure hash', () => {
    const gov = new Governance({
      allowTables: ['*'],
      maskColumns: ['email'],
      maxRows: 50,
    })
    const result = gov.redact(
      { rows: [{ id: 1, email: 'a@b.com', note: 'hello' }], rowCount: 1, fields: ['id', 'email', 'note'] } as never,
      {},
      undefined,
    )
    const compact = JSON.stringify({
      rowCount: result.rowCount,
      fields: ['id', 'email', 'note'],
      rows: result.rows,
      truncated: false,
    })
    expect(compact).toBe(
      '{"rowCount":1,"fields":["id","email","note"],"rows":[{"id":1,"email":"[MASKED_PII]","note":"hello"}],"truncated":false}',
    )
    const pretty = JSON.stringify(
      {
        rowCount: result.rowCount,
        fields: ['id', 'email', 'note'],
        rows: result.rows,
        truncated: false,
      },
      null,
      2,
    )
    expect(hashDisclosure(pretty)).toEqual({
      hash: 'sha256:aea44042d5e759e515151183a6f3cc14d8574855e03b4696ec81567b33a51dab',
      bytes: 191,
    })
  })

  it('the field that left is the field that was hashed — __proto__ is in both', () => {
    const gov = new Governance({
      allowTables: ['*'],
      maskColumns: ['email'],
      maxRows: 50,
    })
    const input = rowWithProto({ email: 'a@b.com' })
    const result = gov.redact(
      { rows: [input], rowCount: 1, fields: ['__proto__', 'email'] } as never,
      {},
      undefined,
    )
    const responseJson = JSON.stringify(
      {
        rowCount: result.rowCount,
        fields: ['__proto__', 'email'],
        rows: result.rows,
        truncated: false,
      },
      null,
      2,
    )
    expect(ownProto(result.rows[0] as object)).toBe(true)
    expect(responseJson).toMatch(/"__proto__"\s*:/)
  })
})
