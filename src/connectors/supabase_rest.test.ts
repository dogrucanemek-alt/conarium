import { describe, expect, it } from 'vitest'
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

