import { describe, expect, it } from 'vitest'
import { PolicyError } from '../governance.js'
import { guardOracleQuery, oracleAdapter } from './oracle.js'

const policy = {
  allowTables: ['app.customers'],
  denyTables: ['app.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

function denied(sql: string) {
  expect(() => guardOracleQuery(sql, policy)).toThrow(PolicyError)
}

describe('oracle inventory locks', () => {
  it('denies ROWNUM (not a row cap)', () => {
    denied('SELECT id FROM app.customers WHERE ROWNUM <= 50')
  })

  it('denies UTL_* / DBMS_*', () => {
    denied("SELECT UTL_HTTP.REQUEST('http://x') FROM dual")
    denied('SELECT DBMS_RANDOM.VALUE FROM app.customers')
  })

  it('denies BEGIN blocks', () => {
    denied('BEGIN DBMS_OUTPUT.PUT_LINE(1); END;')
  })

  it('denies database links', () => {
    denied('SELECT id FROM app.customers@dblink')
  })

  it('unparseable input is denied, not passed', () => {
    const garbage = oracleAdapter.inspect('not sql at all !!!')
    expect(garbage.parseFailed).toBe(true)
    expect(garbage.statementCount).toBe(0)
    denied('not sql at all !!!')
  })

  it('caps a bare SELECT with FETCH FIRST 50', () => {
    const out = guardOracleQuery('SELECT id FROM app.customers', policy)
    expect(out.sql).toMatch(/fetch\s+first\s+50\s+rows\s+only/i)
    expect(out.metadata.appliedRowCap).toBe(50)
  })

  it('does not treat @ inside a string as a dblink', () => {
    const out = guardOracleQuery("SELECT email || '@x' AS glued FROM app.customers", policy)
    expect(out.aliases.glued).toBe('email')
  })
})
