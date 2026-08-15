/**
 * Fuzz the SQL gate parse+deny path for all three dialects.
 *
 * Invariant: broken input never takes the allow path as an uncaught throw.
 * Deny is PolicyError. Any other exception class is a crash.
 */
import { Governance, PolicyError } from '../dist/governance.js'
import { guardMssqlQuery } from '../dist/sql-gate/mssql.js'
import { guardOracleQuery } from '../dist/sql-gate/oracle.js'

const PG = new Governance({
  allowTables: ['public.customers'],
  denyTables: ['public.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
})

const MSSQL = {
  allowTables: ['dbo.customers'],
  denyTables: ['dbo.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

const ORACLE = {
  allowTables: ['app.customers'],
  denyTables: ['app.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

function isControlled(err) {
  return err instanceof PolicyError || err?.name === 'PolicyError'
}

function run(label, fn) {
  try {
    fn()
  } catch (err) {
    if (isControlled(err)) return
    err.message = `${label}: ${err.message}`
    throw err
  }
}

export function fuzz(data) {
  const sql = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  run('postgres', () => PG.guardQuery(sql))
  run('mssql', () => guardMssqlQuery(sql, MSSQL))
  run('oracle', () => guardOracleQuery(sql, ORACLE))
}
