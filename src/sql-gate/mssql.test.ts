import { describe, expect, it } from 'vitest'
import { PolicyError } from '../governance.js'
import { guardMssqlQuery, mssqlAdapter } from './mssql.js'

const policy = {
  allowTables: ['dbo.customers'],
  denyTables: ['dbo.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

function denied(sql: string) {
  expect(() => guardMssqlQuery(sql, policy)).toThrow(PolicyError)
}

describe('mssql inventory locks (parser-accepted bypasses)', () => {
  it('denies GO even when the parser treats it as an alias', () => {
    denied('SELECT id FROM dbo.customers GO')
  })

  it('denies OPENROWSET even when tableList is empty', () => {
    denied("SELECT * FROM OPENROWSET('a','b')")
  })

  it('denies OPENQUERY / OPENDATASOURCE by name', () => {
    denied("SELECT * FROM OPENQUERY(linked, 'SELECT 1')")
    denied("SELECT * FROM OPENDATASOURCE('SQLOLEDB','Data Source=x').db.dbo.t")
  })

  it('denies EXEC / xp_ / sp_', () => {
    denied('EXEC xp_cmdshell \'dir\'')
    denied('EXECUTE sp_helpdb')
  })

  it('denies TOP n PERCENT', () => {
    denied('SELECT TOP 100 PERCENT id FROM dbo.customers')
  })

  it('denies 4-part / linked-server names', () => {
    denied('SELECT id FROM server.db.dbo.customers')
  })

  it('denies FOR XML / FOR JSON / SET ROWCOUNT', () => {
    denied('SELECT id FROM dbo.customers FOR XML AUTO')
    denied('SELECT id FROM dbo.customers FOR JSON PATH')
    denied('SET ROWCOUNT 50')
  })

  it('unparseable input is denied, not passed', () => {
    const garbage = mssqlAdapter.inspect('not sql at all !!!')
    expect(garbage.parseFailed).toBe(true)
    expect(garbage.statementCount).toBe(0)
    denied('not sql at all !!!')
  })

  it('caps a bare SELECT with TOP 50', () => {
    const out = guardMssqlQuery('SELECT id FROM dbo.customers', policy)
    expect(out.sql).toMatch(/top\s+50/i)
    expect(out.metadata.appliedRowCap).toBe(50)
  })
})

describe('G14 — MSSQL function allow-list + locking hints', () => {
  it('denies STRING_AGG (dump aggregate)', () => {
    denied("SELECT STRING_AGG(email, ',') FROM dbo.customers")
  })

  it('denies schema-qualified user functions', () => {
    denied('SELECT dbo.fn_x(id) FROM dbo.customers')
  })

  it('denies WITH (UPDLOCK) / WITH (XLOCK)', () => {
    denied('SELECT id FROM dbo.customers WITH (UPDLOCK)')
    denied('SELECT id FROM dbo.customers WITH (XLOCK)')
    denied('SELECT id FROM dbo.customers WITH (NOLOCK, UPDLOCK)')
  })

  it('COUNT / SUM / COALESCE stay permitted', () => {
    expect(guardMssqlQuery('SELECT COUNT(*) FROM dbo.customers', policy).sql).toMatch(/count/i)
    expect(guardMssqlQuery('SELECT SUM(id) FROM dbo.customers', policy).sql).toMatch(/sum/i)
    expect(guardMssqlQuery("SELECT COALESCE(email, 'x') FROM dbo.customers", policy).sql).toMatch(/coalesce/i)
  })
})
