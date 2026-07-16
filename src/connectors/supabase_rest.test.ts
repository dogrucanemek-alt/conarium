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

