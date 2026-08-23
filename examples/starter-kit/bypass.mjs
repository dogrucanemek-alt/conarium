#!/usr/bin/env node
/**
 * Query the demo role from outside the gateway, then reconcile.
 * Expects observed-without-receipt >= 1.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CORE = join(here, 'node_modules', '@conarium-ai', 'core')
const RECONCILE = join(CORE, 'bin', 'conarium-reconcile.mjs')
const RECEIPTS = join(here, 'conarium-receipts.jsonl')
const SNAPS = join(here, 'snapshots')

function die(msg) {
  console.error(`FAIL  ${msg}`)
  process.exit(1)
}

function compose(args) {
  return spawnSync('docker', ['compose', ...args], { cwd: here, encoding: 'utf8' })
}

function psql(sql) {
  const r = compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'conarium_gate',
    '-d',
    'conarium_demo',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ])
  if (r.status !== 0) die(`psql: ${(r.stderr || r.stdout || '').slice(0, 800)}`)
  return (r.stdout || '').trim()
}

const snapshotSql = `
select json_build_object(
  'v', 'conarium-dbsnapshot/0.1',
  'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'role', 'conarium_gate',
  'source', 'pg_stat_statements',
  'entries', coalesce((
    select json_agg(json_build_object(
      'queryid', s.queryid::text,
      'query', s.query,
      'calls', s.calls
    ))
    from pg_stat_statements s
    join pg_roles r on r.oid = s.userid
    where r.rolname = 'conarium_gate'
  ), '[]'::json)
) as snapshot;
`.trim()

if (!existsSync(RECONCILE)) die('run npm ci in this directory first')
if (!existsSync(RECEIPTS)) die('run npm start first (needs a receipt file)')

mkdirSync(SNAPS, { recursive: true })
const before = join(SNAPS, 'bypass-before.json')
const after = join(SNAPS, 'bypass-after.json')
writeFileSync(before, psql(snapshotSql))
psql("SELECT name FROM public.customers WHERE name = 'Ada Example';")
writeFileSync(after, psql(snapshotSql))

const r = spawnSync(
  process.execPath,
  [
    RECONCILE,
    '--before',
    before,
    '--after',
    after,
    '--receipts',
    RECEIPTS,
    '--profile',
    join(here, 'mapping-profile.json'),
    '--json-v2',
  ],
  { cwd: here, encoding: 'utf8' },
)
let json = null
try {
  json = JSON.parse(r.stdout || '{}')
} catch {
  die(`reconcile did not print JSON: ${(r.stdout || r.stderr || '').slice(0, 400)}`)
}
const n = json.counts?.['observed-without-receipt'] ?? 0
console.log(`reconcile exit ${r.status}`)
console.log(`observed-without-receipt  ${n}`)
console.log(`outcome                   ${json.outcome ?? '?'}`)
if (n < 1) die('expected observed-without-receipt >= 1 after an out-of-gate query')
console.log('PASS  bypass is visible (observed-without-receipt >= 1)')
