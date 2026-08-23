#!/usr/bin/env node
/**
 * One command: four mediated queries, two out-of-gate queries, verify
 * (clean), reconcile (two misses). The red path is the scenario.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '..', '..')
const CORE = existsSync(join(REPO, 'bin', 'conarium-verify.mjs'))
  ? REPO
  : join(here, 'node_modules', '@conarium-ai', 'core')
const GATEWAY = join(CORE, 'dist', 'index.js')
const INIT = join(CORE, 'bin', 'conarium-init.mjs')
const VERIFY = join(CORE, 'bin', 'conarium-verify.mjs')
const RECONCILE = join(CORE, 'bin', 'conarium-reconcile.mjs')
const KEYS = join(here, '_keys')
const CONFIG = join(here, 'conarium.config.json')
const RECEIPTS = join(here, 'conarium-receipts.jsonl')
const AUDIT = join(here, 'conarium-audit.jsonl')
const SNAPS = join(here, 'snapshots')
const DSN_MARK = '127.0.0.1:54333'

const GATE_QUERIES = [
  'SELECT id, name FROM public.patients ORDER BY id',
  'SELECT id, name FROM public.patients WHERE id = 1',
  'SELECT count(*)::int AS n FROM public.patients',
  "SELECT name FROM public.patients WHERE name = 'Ada Example'",
]

const BYPASS_QUERIES = [
  'SELECT reading FROM public.vitals',
  'SELECT amount FROM public.billing',
]

function die(msg) {
  console.error(`FAIL  ${msg}`)
  process.exit(1)
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: here, encoding: 'utf8', ...opts })
}

function compose(args) {
  return sh('docker', ['compose', ...args])
}

function psql(sql, user = 'conarium_gate') {
  const r = compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    user,
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

function snapshotSql() {
  return `
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
}

function textOf(result) {
  return (result?.content ?? []).map((c) => (c && c.type === 'text' ? c.text : '')).join('\n')
}

function countLines(p) {
  if (!existsSync(p)) return 0
  const t = readFileSync(p, 'utf8').trim()
  return t ? t.split('\n').filter(Boolean).length : 0
}

function objectsOf(item) {
  const raw = item?.objects ?? []
  return raw.map((o) => (typeof o === 'string' ? o : o.table || o.name || JSON.stringify(o)))
}

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
const url = cfg.connectors?.[0]?.config?.url ?? ''
if (!url.includes('127.0.0.1') || !url.includes('54333')) {
  die(`demo DSN is not the local compose port (${DSN_MARK})`)
}

if (!existsSync(GATEWAY)) die('gateway missing — from the repository root: npm ci && npm run build')
if (!existsSync(VERIFY) || !existsSync(RECONCILE)) die('conarium binaries missing')

const up = compose(['up', '-d', '--wait'])
if (up.status !== 0) die(`docker compose up: ${(up.stderr || up.stdout || '').slice(0, 800)}`)

if (!existsSync(join(KEYS, 'audit-ed25519.pem'))) {
  mkdirSync(KEYS, { recursive: true })
  const init = sh(process.execPath, [INIT, '--out', KEYS, '--force'])
  if (init.status !== 0) die(`conarium-init: ${(init.stderr || init.stdout || '').slice(0, 400)}`)
}

mkdirSync(SNAPS, { recursive: true })
for (const p of [RECEIPTS, AUDIT]) {
  if (existsSync(p)) unlinkSync(p)
}

const beforePath = join(SNAPS, 'before.json')
const afterPath = join(SNAPS, 'after.json')
writeFileSync(beforePath, psql(snapshotSql()))

const signingKey = join(KEYS, 'audit-ed25519.pem')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [GATEWAY, '--config', CONFIG],
  cwd: here,
  env: { ...getDefaultEnvironment(), CONARIUM_AUDIT_SIGNING_KEY: signingKey },
  stderr: 'pipe',
})
const client = new Client({ name: 'missing-record-demo', version: '0.2.48' })
try {
  await client.connect(transport)
  for (const sql of GATE_QUERIES) {
    const out = await client.callTool({ name: 'query', arguments: { sql } })
    if (out.isError) die(`query failed: ${textOf(out)}`)
  }
} finally {
  try {
    await client.close()
  } catch {
    /* already gone */
  }
}

for (const sql of BYPASS_QUERIES) psql(sql)

writeFileSync(afterPath, psql(snapshotSql()))

const receipts = countLines(RECEIPTS)
const pub = join(KEYS, 'audit-ed25519.pub.pem')
const verify = sh(process.execPath, [VERIFY, RECEIPTS, '--pubkey', pub])
if (verify.status !== 0) {
  die(`conarium-verify exit ${verify.status}: ${(verify.stdout || verify.stderr || '').slice(0, 400)}`)
}
console.log('integrity: clean')

const recon = sh(process.execPath, [
  RECONCILE,
  '--before',
  beforePath,
  '--after',
  afterPath,
  '--receipts',
  RECEIPTS,
  '--profile',
  join(here, 'mapping-profile.json'),
  '--json-v2',
])
let reconJson = null
try {
  reconJson = JSON.parse(recon.stdout || '{}')
} catch {
  die(`reconcile did not print JSON: ${(recon.stdout || recon.stderr || '').slice(0, 400)}`)
}

const owr = reconJson.counts?.['observed-without-receipt'] ?? 0
const misses = (reconJson.items ?? []).filter((i) => i.outcome === 'observed-without-receipt')
const missObjects = [...new Set(misses.flatMap(objectsOf))].sort()

console.log('')
console.log('missing-record-demo')
console.log('-------------------')
console.log(`source events                 6`)
console.log(`receipts                      ${receipts}`)
console.log(`conarium-verify               exit ${verify.status}`)
console.log(`conarium-reconcile            exit ${recon.status}`)
console.log(`observed-without-receipt      ${owr}`)
console.log(`outcome                       ${reconJson.outcome ?? '?'}`)
console.log('')
console.log('object                         class')
for (const item of misses) {
  const names = objectsOf(item).join(', ') || '(none)'
  console.log(`${names.padEnd(32)}${item.outcome}`)
}
console.log('')
console.log('An intact chain missed two events. The second ledger caught them.')

if (receipts !== 4) die(`expected 4 receipts, got ${receipts}`)
if (owr !== 2) die(`expected observed-without-receipt = 2, got ${owr}`)
if (reconJson.outcome !== 'exceptions') die(`expected outcome exceptions, got ${reconJson.outcome}`)
if (recon.status === 0) die('reconcile exited 0; the misses should fail the comparison')
const expected = ['billing', 'vitals']
const got = missObjects.map((n) => n.replace(/^public\./, ''))
if (expected.some((name) => !got.some((g) => g === name || g.endsWith(`.${name}`)))) {
  die(`expected objects vitals and billing, got ${missObjects.join(', ') || '(none)'}`)
}
process.exit(0)
