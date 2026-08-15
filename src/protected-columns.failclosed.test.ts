/**
 * P3 — if we cannot prove a protected column is absent from a predicate,
 * the query (or the process) is refused. No silent hole.
 */
import { describe, it, expect } from 'vitest'
import { parseConariumConfig } from './config.js'
import { Governance, PolicyError } from './governance.js'
import { enforceProtectedColumns } from './protected-columns.js'

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

const gov = () =>
  new Governance({
    allowTables: ['public.customers', 'public.orders'],
    protectedColumns: ['*.email'],
  })

describe('P3 fail-closed protectedColumns', () => {
  it('CTE alias of a protected column in WHERE is denied', () => {
    expect(() =>
      gov().guardQuery(
        "WITH x AS (SELECT email AS e FROM public.customers) SELECT 1 FROM x WHERE e LIKE 'a%'",
      ),
    ).toThrow(/protected column "customers\.email" may not appear in WHERE/)
  })

  it('subquery alias of a protected column in WHERE is denied', () => {
    expect(() =>
      gov().guardQuery(
        "SELECT 1 FROM (SELECT email AS e FROM public.customers) t WHERE t.e LIKE 'a%'",
      ),
    ).toThrow(/protected column "customers\.email" may not appear in WHERE/)
  })

  it('SELECT * still allowed; WHERE on the original name is still denied', () => {
    expect(() => gov().guardQuery('SELECT * FROM public.customers')).not.toThrow()
    expect(() =>
      gov().guardQuery(
        "WITH x AS (SELECT * FROM public.customers) SELECT 1 FROM x WHERE email LIKE 'a%'",
      ),
    ).toThrow(/may not appear in WHERE/)
  })

  it('an unclassified statement type is denied, not passed', () => {
    expect(() =>
      enforceProtectedColumns({ type: 'insert' } as never, ['*.email'], (reason) => {
        throw new Error(reason)
      }),
    ).toThrow(/cannot classify this statement/)
  })

  it('mssql + protectedColumns is rejected at config load', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: {
          allowConnectors: ['docs'],
          dialect: 'mssql',
          protectedColumns: ['*.email'],
        },
      }),
    ).toThrow(/protectedColumns requires a dialect/)
  })

  it('oracle + protectedColumns is rejected at config load', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: {
          allowConnectors: ['docs'],
          dialect: 'oracle',
          protectedColumns: ['*.email'],
        },
      }),
    ).toThrow(/dialect "oracle"/)
  })

  it('Governance constructor rejects mssql + protectedColumns', () => {
    expect(
      () => new Governance({ dialect: 'mssql', protectedColumns: ['*.email'] }),
    ).toThrow(/protectedColumns requires a dialect/)
  })

  it('postgres + protectedColumns loads; mssql without the field still loads', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { allowConnectors: ['docs'], dialect: 'postgres', protectedColumns: ['*.email'] },
      }),
    ).not.toThrow()
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { allowConnectors: ['docs'], dialect: 'mssql' },
      }),
    ).not.toThrow()
  })
})
