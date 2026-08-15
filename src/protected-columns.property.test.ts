/**
 * P5 — the promise is the test. A protected column in a predicate position
 * is never a successful guard. Omitted field keeps today's behaviour.
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { Governance, PolicyError } from './governance.js'

const ALLOW = ['public.customers', 'public.orders'] as const

const withField = () =>
  new Governance({
    allowTables: [...ALLOW],
    protectedColumns: ['*.email'],
  })

const withoutField = () =>
  new Governance({
    allowTables: [...ALLOW],
  })

const POSITIONS = ['where', 'having', 'join', 'order', 'group', 'select-derived'] as const
const QUALIFIERS = ['email', 'c.email'] as const
const PREDICATES = [
  "LIKE 'a%'",
  "LIKE 'b%'",
  "= 'x'",
  "<> ''",
  'IS NOT NULL',
  "IN ('a', 'b')",
] as const
const DERIVED = ['length', 'lower', 'upper', 'trim'] as const

function sqlFor(
  position: (typeof POSITIONS)[number],
  qualifier: (typeof QUALIFIERS)[number],
  predicate: (typeof PREDICATES)[number],
  derived: (typeof DERIVED)[number],
  cte: boolean,
): string {
  if (cte && position === 'where') {
    return `WITH x AS (SELECT ${qualifier} AS e FROM public.customers c) SELECT 1 FROM x WHERE e ${predicate}`
  }
  switch (position) {
    case 'where':
      return `SELECT id FROM public.customers c WHERE ${qualifier} ${predicate}`
    case 'having':
      return `SELECT city FROM public.customers c GROUP BY city HAVING ${qualifier} ${predicate}`
    case 'join':
      return `SELECT c.id FROM public.customers c JOIN public.orders o ON ${qualifier} = o.note`
    case 'order':
      return `SELECT id FROM public.customers c ORDER BY ${qualifier}`
    case 'group':
      return `SELECT 1 FROM public.customers c GROUP BY ${qualifier}`
    case 'select-derived':
      return `SELECT ${derived}(${qualifier}) FROM public.customers c`
  }
}

function succeeded(gov: Governance, sql: string): boolean {
  try {
    gov.guardQuery(sql)
    return true
  } catch {
    return false
  }
}

describe('P5 protectedColumns proof', () => {
  it('blind channel: LIKE a% and LIKE b% are both denied — no rowCount delta', () => {
    const gov = withField()
    const a = "SELECT id FROM public.customers WHERE email LIKE 'a%'"
    const b = "SELECT id FROM public.customers WHERE email LIKE 'b%'"
    expect(() => gov.guardQuery(a)).toThrow(PolicyError)
    expect(() => gov.guardQuery(b)).toThrow(PolicyError)
    expect(() => gov.guardQuery(a)).toThrow(/WHERE/)
    expect(() => gov.guardQuery(b)).toThrow(/WHERE/)
  })

  it('same query is allowed without the field and denied with it', () => {
    const sql = "SELECT id FROM public.customers WHERE email LIKE 'a%'"
    expect(() => withoutField().guardQuery(sql)).not.toThrow()
    expect(() => withField().guardQuery(sql)).toThrow(PolicyError)
    expect(() => withField().guardQuery(sql)).toThrow(/protected column/)
  })

  it('omitted field still allows ORDER BY / JOIN / GROUP BY on email', () => {
    const gov = withoutField()
    expect(() => gov.guardQuery('SELECT id FROM public.customers ORDER BY email')).not.toThrow()
    expect(() =>
      gov.guardQuery('SELECT c.id FROM public.customers c JOIN public.orders o ON c.email = o.note'),
    ).not.toThrow()
    expect(() => gov.guardQuery('SELECT 1 FROM public.customers GROUP BY email')).not.toThrow()
  })

  it('postgres position matrix — six positions denied', () => {
    const gov = withField()
    const cases: Array<[string, string]> = [
      ["SELECT id FROM public.customers WHERE email LIKE 'a%'", 'WHERE'],
      ["SELECT city FROM public.customers GROUP BY city HAVING email LIKE 'a%'", 'HAVING'],
      ['SELECT c.id FROM public.customers c JOIN public.orders o ON c.email = o.note', 'JOIN'],
      ['SELECT id FROM public.customers ORDER BY email', 'ORDER BY'],
      ['SELECT 1 FROM public.customers GROUP BY email', 'GROUP BY'],
      ['SELECT length(email) FROM public.customers', 'SELECT'],
    ]
    for (const [sql, position] of cases) {
      expect(() => gov.guardQuery(sql), sql).toThrow(new RegExp(`may not appear in ${position}`))
    }
  })

  it('property: a protected column in a predicate position is never a success (≥1000)', () => {
    const gov = withField()
    fc.assert(
      fc.property(
        fc.constantFrom(...POSITIONS),
        fc.constantFrom(...QUALIFIERS),
        fc.constantFrom(...PREDICATES),
        fc.constantFrom(...DERIVED),
        fc.boolean(),
        (position, qualifier, predicate, derived, cte) => {
          const sql = sqlFor(position, qualifier, predicate, derived, cte)
          expect(succeeded(gov, sql), sql).toBe(false)
        },
      ),
      { numRuns: 1000 },
    )
  })
})
