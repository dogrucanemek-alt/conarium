import { describe, expect, it, vi } from 'vitest'
import { Governance, PolicyError } from '../governance.js'
import { parseConariumConfig } from '../config.js'
import {
  guardSqlByDialect,
  loadSqlGate,
  resolveSqlDialect,
} from './dispatch.js'

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

describe('resolveSqlDialect', () => {
  it('omitted is postgres — today\'s path', () => {
    expect(resolveSqlDialect(undefined)).toBe('postgres')
  })

  it('accepts the three declared values', () => {
    expect(resolveSqlDialect('postgres')).toBe('postgres')
    expect(resolveSqlDialect('mssql')).toBe('mssql')
    expect(resolveSqlDialect('oracle')).toBe('oracle')
  })

  it('rejects typos, case folds, and mysql — no silent fallback', () => {
    for (const bad of ['mysql', 'Postgres', 'ORACLE', 'orcale', 'sqlserver', '', null, 1]) {
      expect(() => resolveSqlDialect(bad), String(bad)).toThrow(/policy\.dialect/)
      expect(() => resolveSqlDialect(bad), String(bad)).not.toThrow(/postgres gate/)
    }
  })
})

describe('parseConariumConfig — dialect', () => {
  it('keeps an explicit dialect', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: { dialect: 'oracle', allowTables: ['app.customers'] },
    })
    expect(cfg.policy?.dialect).toBe('oracle')
  })

  it('omitted dialect stays omitted (runtime default is postgres)', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: { allowTables: ['public.customers'] },
    })
    expect(cfg.policy?.dialect).toBeUndefined()
  })

  it('rejects an unknown dialect at load — does not become postgres', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { dialect: 'mysql' },
      }),
    ).toThrow(/Invalid enum value|dialect/)
  })

  it('rejects dialect on a profile (cannot switch the parser per person)', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: {
          profiles: { patron: { dialect: 'oracle' } },
        },
      }),
    ).toThrow(/Unrecognized key/)
  })
})

describe('guardSqlByDialect — the right gate, not a guess', () => {
  it('postgres dialect calls the postgres function even when SQL looks like T-SQL', async () => {
    const postgresGuard = vi.fn((sql: string) => {
      return new Governance({ allowTables: ['*'] }).guardQuery(sql)
    })
    expect(() =>
      guardSqlByDialect('postgres', 'SELECT TOP 50 id FROM dbo.customers', { allowTables: ['*'] }, postgresGuard),
    ).toThrow(PolicyError)
    expect(postgresGuard).toHaveBeenCalledTimes(1)
  })

  it('mssql dialect calls the MSSQL gate, not postgres', async () => {
    await loadSqlGate('mssql')
    const postgresGuard = vi.fn(() => {
      throw new Error('postgres gate must not run')
    })
    const out = guardSqlByDialect(
      'mssql',
      'SELECT id FROM dbo.customers',
      { allowTables: ['dbo.customers'], maxRows: 50 },
      postgresGuard,
    )
    expect(postgresGuard).not.toHaveBeenCalled()
    expect(out.sql).toMatch(/TOP\s+50/i)
    expect(out.sql).not.toMatch(/\bLIMIT\b/i)
  })

  it('oracle dialect calls the Oracle gate, not postgres', async () => {
    await loadSqlGate('oracle')
    const postgresGuard = vi.fn(() => {
      throw new Error('postgres gate must not run')
    })
    const out = guardSqlByDialect(
      'oracle',
      'SELECT id FROM app.customers',
      { allowTables: ['app.customers'], maxRows: 50 },
      postgresGuard,
    )
    expect(postgresGuard).not.toHaveBeenCalled()
    expect(out.sql).toMatch(/FETCH FIRST 50 ROWS ONLY/i)
    expect(out.sql).toMatch(/\bconarium_cap\b/)
    expect(out.sql).not.toMatch(/\bLIMIT\b/i)
  })
})

describe('Governance.guardSql', () => {
  it('without dialect matches guardQuery (postgres regression)', () => {
    const gov = new Governance({ allowTables: ['public.customers'], maxRows: 50 })
    const a = gov.guardQuery('SELECT id FROM public.customers')
    const b = gov.guardSql('SELECT id FROM public.customers')
    expect(b.sql).toBe(a.sql)
    expect(b.metadata.appliedRowCap).toBe(a.metadata.appliedRowCap)
    expect(gov.dialect()).toBe('postgres')
  })

  it('hand-built invalid dialect is rejected — not postgres', () => {
    expect(() => new Governance({ dialect: 'mysql' as 'postgres' })).toThrow(/policy\.dialect/)
  })
})
