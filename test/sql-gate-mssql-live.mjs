#!/usr/bin/env node
/**
 * Live MSSQL proof for sql-gate D.
 * Speaks to mcr.microsoft.com/mssql/server through the mssql-tools sidecar.
 * Local docker password only — not a product secret.
 */
import { spawnSync } from 'node:child_process'
import { callShippedQuery } from './mcp-query-live.mjs'

const container = process.env.MSSQL_CONTAINER ?? 'conarium-mssql-gate'
const password = process.env.MSSQL_SA_PASSWORD ?? 'Conarium_Gate1'
const policy = {
  allowTables: ['dbo.customers'],
  denyTables: ['dbo.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

function wsl(args, opts = {}) {
  const r = spawnSync('wsl', ['-e', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  })
  return r
}

function ensureUp() {
  wsl(['docker', 'update', '--restart=unless-stopped', container])
  wsl(['docker', 'start', container])
  for (let i = 0; i < 30; i++) {
    const ping = sqlcmd('SELECT 1', { allowFail: true })
    if (ping.ok) return
    const slept = spawnSync('wsl', ['-e', 'sleep', '2'], { encoding: 'utf8' })
    void slept
  }
  throw new Error('MSSQL container did not accept connections')
}

function sqlcmd(query, { allowFail = false } = {}) {
  const r = wsl([
    'docker', 'run', '--rm',
    '--network', `container:${container}`,
    'mcr.microsoft.com/mssql-tools',
    '/opt/mssql-tools/bin/sqlcmd',
    '-S', '127.0.0.1',
    '-U', 'sa',
    '-P', password,
    '-Q', query,
    '-W',
    '-h-1',
  ])
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0) {
    if (allowFail) return { ok: false, out }
    throw new Error(`sqlcmd exit ${r.status}: ${out.trim()}`)
  }
  return { ok: true, out }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

ensureUp()

sqlcmd(`
IF OBJECT_ID('dbo.customers','U') IS NOT NULL DROP TABLE dbo.customers;
IF OBJECT_ID('dbo.secrets','U') IS NOT NULL DROP TABLE dbo.secrets;
CREATE TABLE dbo.customers (id int, email nvarchar(200));
CREATE TABLE dbo.secrets (id int, email nvarchar(200));
;WITH n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i < 80)
INSERT INTO dbo.customers (id, email) SELECT i, CONCAT('user', i, '@example.com') FROM n OPTION (MAXRECURSION 80);
INSERT INTO dbo.secrets (id, email) VALUES (1, 'secret@example.com');
`)

const ungated = sqlcmd('SELECT COUNT(*) FROM dbo.customers')
assert(/80/.test(ungated.out), `ungated customers should be 80, got: ${ungated.out}`)

function countFrom(sql) {
  const capped = sqlcmd(`SELECT COUNT(*) FROM (${sql}) AS _c`)
  const n = Number((capped.out.match(/(?:^|\n)\s*(\d+)\s*(?:\n|$)/) || [])[1])
  if (!Number.isFinite(n)) throw new Error(`could not parse count from: ${capped.out}`)
  return { rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), rowCount: n, fields: ['id'] }
}

const customers = await callShippedQuery({
  dialect: 'mssql',
  policy,
  execute: countFrom,
  sql: 'SELECT id FROM dbo.customers',
})
assert(customers.seen.length === 1, 'mssql query must reach the connector once')
assert(/TOP\s+50/i.test(customers.seen[0]), `rewritten SQL missing TOP 50: ${customers.seen[0]}`)
const body = JSON.parse(customers.result.content[0].text)
assert(body.rowCount === 50, `gated count should be 50, got: ${body.rowCount}\nSQL=${customers.seen[0]}`)

let secretsDenied = false
try {
  await callShippedQuery({ dialect: 'mssql', policy, execute: countFrom, sql: 'SELECT id FROM dbo.secrets' })
} catch { secretsDenied = true }
assert(secretsDenied, 'dbo.secrets must be denied by the gate')

let garbageDenied = false
try {
  await callShippedQuery({ dialect: 'mssql', policy, execute: countFrom, sql: 'not sql at all !!!' })
} catch { garbageDenied = true }
assert(garbageDenied, 'unparseable MSSQL must be denied')

const leak = sqlcmd('SELECT COUNT(*) FROM dbo.secrets')
assert(/1/.test(leak.out), `ungated secrets must exist so deny is not a vacuum: ${leak.out}`)

console.log('PASS mssql-live')
console.log(`  container ${container}`)
console.log(`  ungated customers 80`)
console.log(`  gated SQL ${customers.seen[0]}`)
console.log('  path MCP query tool')
console.log(`  gated rows 50`)
console.log('  secrets denied by gate; ungated row still present')
console.log('  unparseable denied')
