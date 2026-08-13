import { describe, expect, it } from 'vitest'
import { Governance } from '../governance.js'
import { SupabaseRestConnector } from './supabase_rest.js'

describe('SupabaseRestConnector parseSimpleSelect', () => {
  const c = new SupabaseRestConnector({
    type: 'supabase-rest',
    name: 't',
    description: 't',
    config: { allowTables: 'sale_lines,price_alerts', schema: 'zion' },
  })

  it('parses select star with limit', () => {
    expect(c.parseSimpleSelect('SELECT * FROM zion.sale_lines LIMIT 5')).toEqual({
      table: 'sale_lines',
      columns: ['*'],
      limit: 5,
    })
  })

  it('rejects write tokens', () => {
    expect(() => c.parseSimpleSelect('DELETE FROM zion.sale_lines')).toThrow(/Write|SELECT/)
  })

  it('rejects join/where for now', () => {
    expect(() =>
      c.parseSimpleSelect('SELECT * FROM zion.sale_lines WHERE id = 1')
    ).toThrow(/only allows/)
  })

  it('rejects SQL AS alias and says why (column policy matches real names)', () => {
    expect(() =>
      c.parseSimpleSelect('SELECT customer_name AS x FROM zion.sale_lines LIMIT 1')
    ).toThrow(/Column aliases/)
  })

  it('rejects PostgREST colon alias and says why', () => {
    expect(() =>
      c.parseSimpleSelect('SELECT customer_name:x FROM zion.sale_lines LIMIT 1')
    ).toThrow(/Column aliases/)
  })

  it('parses a real column name without alias', () => {
    expect(c.parseSimpleSelect('SELECT customer_name FROM zion.sale_lines LIMIT 1')).toEqual({
      table: 'sale_lines',
      columns: ['customer_name'],
      limit: 1,
    })
  })
})

describe('REST-style redact: empty maskedFields still honours column names', () => {
  it('customer_name is masked when the REST path leaves maskedFields empty', () => {
    const gov = new Governance({
      allowTables: ['zion.sale_lines'],
      maskColumns: ['*.customer_name'],
    })
    const out = gov.redact(
      {
        rows: [{ customer_name: 'Ayşe Yılmaz', amount: 12 }],
        rowCount: 1,
        fields: ['customer_name', 'amount'],
        sql: 'SELECT customer_name, amount FROM zion.sale_lines LIMIT 1',
      },
      {},
      {
        accessedTables: ['zion.sale_lines'],
        accessedFunctions: [],
        maskedFields: [],
        maskedCount: 0,
        denied: false,
      },
    )
    expect(out.rows[0].customer_name).toBe('[MASKED_PII]')
    expect(out.rows[0].amount).toBe(12)
  })
})

describe('SupabaseRestConnector non-default schema', () => {
  const c = new SupabaseRestConnector({
    type: 'supabase-rest',
    name: 'demo-db',
    description: 'demo',
    config: { allowTables: 'monthly_revenue', schema: 'demo' },
  })

  it('exposes its configured schema (callers must not hard-code one)', () => {
    expect(c.schemaName).toBe('demo')
  })

  it('parses tables qualified with that schema', () => {
    expect(c.parseSimpleSelect('SELECT * FROM demo.monthly_revenue LIMIT 3')).toEqual({
      table: 'monthly_revenue',
      columns: ['*'],
      limit: 3,
    })
  })

  it('rejects a table qualified with a foreign schema', () => {
    expect(() => c.parseSimpleSelect('SELECT * FROM zion.sale_lines LIMIT 1')).toThrow(/Only schema/)
  })

  it('does not leak deployment-specific names into table descriptions', async () => {
    const tables = await c.listTables()
    expect(tables[0].description).toBe('demo.monthly_revenue')
    expect(JSON.stringify(tables)).not.toMatch(/zion|codes/i)
  })
})

