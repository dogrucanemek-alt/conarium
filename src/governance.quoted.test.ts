import { describe, expect, it } from 'vitest'
import { Governance, PolicyError } from './governance.js'

// Regression: Codex denetimi 2026-07-06 P2 — quoted mixed-case identifier bypass.
// Postgres treats `public."Customers"` as a DIFFERENT table than public.customers,
// but lowercase-folding policy matching used to let it ride the allow-list entry.
describe('quoted mixed-case identifiers', () => {
  const gov = new Governance({
    allowTables: ['public.customers'],
    maskColumns: ['*.email'],
  })

  it('still allows the folded lowercase table', () => {
    expect(() => gov.guardQuery('SELECT id FROM public.customers')).not.toThrow()
  })

  it('allows unquoted uppercase spelling (parser folds it, same table in PG)', () => {
    expect(() => gov.guardQuery('SELECT id FROM public.Customers')).not.toThrow()
  })

  it('allows quoted LOWERCASE identifiers ("customers" is the same object as customers in PG)', () => {
    expect(() => gov.guardQuery('SELECT id FROM public."customers"')).not.toThrow()
  })

  it('denies a quoted mixed-case table even when the folded name is allowed', () => {
    expect(() => gov.guardQuery('SELECT id FROM public."Customers"')).toThrow(PolicyError)
    expect(() => gov.guardQuery('SELECT id FROM public."Customers"')).toThrow(/mixed-case/i)
  })

  it('denies a quoted mixed-case schema', () => {
    expect(() => gov.guardQuery('SELECT id FROM "Public".customers')).toThrow(/mixed-case/i)
  })

  it('denies quoted mixed-case inside a JOIN', () => {
    expect(() =>
      gov.guardQuery('SELECT c.id FROM public.customers c JOIN public."Orders" o ON o.customer_id = c.id')
    ).toThrow(/mixed-case/i)
  })

  it('denies quoted mixed-case inside a CTE body', () => {
    expect(() =>
      gov.guardQuery('WITH x AS (SELECT id FROM public."Customers") SELECT * FROM x')
    ).toThrow(/mixed-case/i)
  })
})
