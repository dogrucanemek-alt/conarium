import { describe, expect, it } from 'vitest'
import {
  BLOCKED_DUMP_FUNCTIONS,
  findWriteToken,
  hasRowLockClause,
  isSafeBuiltinFunction,
  isSelectOrWith,
  normalizedSqlHead,
  SAFE_BUILTIN_FUNCTIONS,
  WRITE_TOKENS,
} from './rules.js'
import { postgresAdapter } from './postgres.js'

describe('sql-gate rules (lock — do not silently shrink)', () => {
  it('keeps the write-token list the gate was measured with', () => {
    expect([...WRITE_TOKENS]).toEqual([
      'DROP ', 'TRUNCATE ', 'DELETE ', 'UPDATE ', 'INSERT ', 'ALTER ', 'CREATE ',
      'GRANT ', 'REVOKE ', 'MERGE ', 'COPY ', 'CALL ', 'DO ', 'VACUUM ',
    ])
  })

  it('keeps dump aggregates blocked', () => {
    expect([...BLOCKED_DUMP_FUNCTIONS].sort()).toEqual([
      'array_agg', 'json_agg', 'jsonb_agg', 'row_to_json', 'string_agg',
    ])
  })

  it('count/coalesce stay on the allow-list; array_agg does not', () => {
    expect(isSafeBuiltinFunction('count')).toBe(true)
    expect(isSafeBuiltinFunction('coalesce')).toBe(true)
    expect(SAFE_BUILTIN_FUNCTIONS.has('array_agg')).toBe(false)
  })

  it('read-only head and write tokens match guardQuery', () => {
    expect(isSelectOrWith(normalizedSqlHead('select 1'))).toBe(true)
    expect(isSelectOrWith(normalizedSqlHead('WITH x AS (SELECT 1) SELECT * FROM x'))).toBe(true)
    expect(isSelectOrWith(normalizedSqlHead('DELETE FROM t'))).toBe(false)
    expect(findWriteToken(normalizedSqlHead('DELETE FROM t'))).toBe('DELETE')
    expect(hasRowLockClause(normalizedSqlHead('SELECT 1 FROM t FOR UPDATE'))).toBe(true)
  })

  it('postgres inspect is fail-closed on garbage', () => {
    const bad = postgresAdapter.inspect('not sql at all !!!')
    expect(bad.parseFailed).toBe(true)
    expect(bad.statementCount).toBe(0)
    const ok = postgresAdapter.inspect('SELECT 1')
    expect(ok.parseFailed).toBe(false)
    expect(ok.statementCount).toBe(1)
  })
})
