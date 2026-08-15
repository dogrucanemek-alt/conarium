/**
 * P2 — protected column in a predicate position is denied.
 * Bare SELECT of the same column is still allowed (masked on the way out).
 */
import { describe, it, expect } from 'vitest'
import { Governance, PolicyError } from './governance.js'

const gov = () =>
  new Governance({
    allowTables: ['public.customers', 'public.orders'],
    protectedColumns: ['*.email'],
  })

function denied(sql: string, position: string, column = 'customers.email') {
  expect(() => gov().guardQuery(sql)).toThrow(PolicyError)
  expect(() => gov().guardQuery(sql)).toThrow(
    new RegExp(`protected column "${column.replace('.', '\\.')}" may not appear in ${position}`),
  )
}

describe('P2 protectedColumns predicate positions', () => {
  it('WHERE', () => {
    denied("SELECT id FROM public.customers WHERE email LIKE 'a%'", 'WHERE')
  })

  it('HAVING', () => {
    denied(
      "SELECT city FROM public.customers GROUP BY city HAVING email LIKE 'a%'",
      'HAVING',
    )
  })

  it('JOIN ON', () => {
    denied(
      'SELECT c.id FROM public.customers c JOIN public.orders o ON c.email = o.note',
      'JOIN',
    )
  })

  it('ORDER BY', () => {
    denied('SELECT id FROM public.customers ORDER BY email', 'ORDER BY')
  })

  it('GROUP BY', () => {
    denied('SELECT city FROM public.customers GROUP BY email', 'GROUP BY')
  })

  it('SELECT derived expression', () => {
    denied('SELECT substring(email from 1 for 1) FROM public.customers', 'SELECT')
    denied("SELECT email LIKE 'a%' FROM public.customers", 'SELECT')
    denied('SELECT length(email) FROM public.customers', 'SELECT')
  })

  it('bare SELECT of a protected column is allowed', () => {
    expect(() => gov().guardQuery('SELECT email FROM public.customers')).not.toThrow()
    expect(() => gov().guardQuery('SELECT email AS e FROM public.customers')).not.toThrow()
  })

  it('SELECT * is allowed', () => {
    expect(() => gov().guardQuery('SELECT * FROM public.customers')).not.toThrow()
  })

  it('WHERE on a non-protected column is allowed', () => {
    expect(() => gov().guardQuery('SELECT id FROM public.customers WHERE id = 1')).not.toThrow()
  })
})
