/**
 * P1 — policy.protectedColumns field, schema, and implied masking.
 * Profiles must not be able to change this field.
 */
import { describe, it, expect } from 'vitest'
import { parseConariumConfig } from './config.js'
import { Governance } from './governance.js'
import type { GovernancePolicy } from './types.js'

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

describe('P1 protectedColumns policy field', () => {
  it('parseConariumConfig accepts protectedColumns on the base policy', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: {
        allowConnectors: ['docs'],
        allowTables: ['public.customers'],
        maskColumns: ['*.phone'],
        protectedColumns: ['customers.email', '*.tckn'],
      },
    })
    expect(cfg.policy?.protectedColumns).toEqual(['customers.email', '*.tckn'])
    expect(cfg.policy?.maskColumns).toEqual(['*.phone'])
  })

  it('rejects protectedColumns on a profile — Unrecognized key', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: {
          allowConnectors: ['docs'],
          protectedColumns: ['*.email'],
          profiles: { patron: { protectedColumns: ['*.email'] } },
        },
      }),
    ).toThrow(/Unrecognized key/)
  })

  it('omitted protectedColumns is undefined — same shape as today', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: {
        allowConnectors: ['docs'],
        maskColumns: ['*.email'],
      },
    })
    expect(cfg.policy?.protectedColumns).toBeUndefined()
  })

  it('protectedColumns also masks output without being listed in maskColumns', () => {
    const gov = new Governance({
      allowTables: ['public.customers'],
      protectedColumns: ['*.customer_name'],
    })
    const guarded = gov.guardQuery('SELECT customer_name, city FROM public.customers')
    const out = gov.redact(
      {
        rows: [{ _table: 'public.customers', customer_name: 'Ada Lovelace', city: 'Izmir' }],
        rowCount: 1,
        fields: ['_table', 'customer_name', 'city'],
      },
      guarded.aliases,
      guarded.metadata,
    )
    expect(out.rows[0].customer_name).toBe('[MASKED_PII]')
    expect(out.rows[0].city).toBe('Izmir')
  })

  it('a profile that empties maskColumns still masks protectedColumns', () => {
    const policy: GovernancePolicy = {
      allowTables: ['public.customers'],
      maskColumns: ['*.customer_name', '*.nickname'],
      protectedColumns: ['*.customer_name'],
      profiles: { boss: { maskColumns: [] } },
      actorProfiles: { a: 'boss' },
    }
    const g = new Governance(policy).forActor({ id: 'a', assurance: 'per-user-token' })
    expect(g.appliedProfile()).toBe('boss')
    const out = g.redact({
      rows: [{ _table: 'public.customers', customer_name: 'Ada Lovelace', nickname: 'Ada' }],
      rowCount: 1,
      fields: ['_table', 'customer_name', 'nickname'],
    })
    expect(out.rows[0].customer_name).toBe('[MASKED_PII]')
    expect(out.rows[0].nickname).toBe('Ada')
  })
})
