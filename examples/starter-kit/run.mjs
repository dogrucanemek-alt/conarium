#!/usr/bin/env node
/**
 * One command after docker compose up: open the gate, run three queries,
 * write receipts, snapshot before/after, reconcile, print a table.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORE = join(here, 'node_modules', '@conarium-ai', 'core')
const GATEWAY = join(CORE, 'dist', 'index.js')
const INIT = join(CORE, 'bin', 'conarium-init.mjs')
const VERIFY = join(CORE, 'bin', 'conarium-verify.mjs')
const RECONCILE = join(CORE, 'bin', 'conarium-reconcile.mjs')
const KEYS = join(here, '_keys')
const CONFIG = join(here, 'conarium.config.json')
const RECEIPTS = join(here, 'conarium-receipts.jsonl')
const AUDIT = join(here, 'conarium-audit.jsonl')
const SNAPS = join(here, 'snapshots')
const DSN_MARK = '127.0.0.1:54332'

const QUERIES = [
  'SELECT id, name FROM public.customers ORDER BY id LIMIT 3',
  'SELECT id, email FROM public.customers WHERE id = 1',
  'SELECT count(*)::int AS n FROM public.customers',
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

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
const url = cfg.connectors?.[0]?.config?.url ?? ''
if (!url.includes('127.0.0.1') || !url.includes('54332')) {
  die(`demo DSN is not the local compose port (${DSN_MARK})`)
}

if (!existsSync(GATEWAY)) die('gateway missing — run npm ci in this directory')

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
const client = new Client({ name: 'starter-kit', version: '0.2.46' })
const rowsOut = []
try {
  await client.connect(transport)
  for (const sql of QUERIES) {
    const out = await client.callTool({ name: 'query', arguments: { sql } })
    if (out.isError) die(`query failed: ${textOf(out)}`)
    const body = JSON.parse(textOf(out))
    rowsOut.push({ sql, n: (body.rows ?? []).length, sample: body.rows?.[0] ?? null })
  }
} finally {
  try {
    await client.close()
  } catch {
    /* already gone */
  }
}

writeFileSync(afterPath, psql(snapshotSql()))

const receipts = countLines(RECEIPTS)
const pub = join(KEYS, 'audit-ed25519.pub.pem')
const verify = sh(process.execPath, [VERIFY, RECEIPTS, '--pubkey', pub])
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
  reconJson = null
}

const emailMasked = rowsOut[1]?.sample?.email === '[MASKED_PII]'
console.log('')
console.log('starter-kit summary')
console.log('------------------')
console.log(`queries          ${rowsOut.length}`)
console.log(`receipts         ${receipts}`)
console.log(`email masked     ${emailMasked ? 'yes' : 'NO'}`)
console.log(`conarium-verify  exit ${verify.status}`)
console.log(`reconcile        exit ${recon.status}`)
if (reconJson?.counts) {
  console.log(`matched          ${reconJson.counts.matched ?? 0}`)
  console.log(`observed-without-receipt  ${reconJson.counts['observed-without-receipt'] ?? 0}`)
  console.log(`indeterminate    ${reconJson.counts.indeterminate ?? 0}`)
  console.log(`outcome          ${reconJson.outcome ?? '?'}`)
}
console.log('')
if (receipts < 3) die(`expected at least 3 receipts, got ${receipts}`)
if (verify.status !== 0) die(`conarium-verify exit ${verify.status}: ${(verify.stdout || verify.stderr || '').slice(0, 400)}`)
if (!emailMasked) die('second query did not mask email')
if (recon.status !== 0 && recon.status !== 40 && recon.status !== 41) {
  die(`reconcile unexpected exit ${recon.status}: ${(recon.stdout || recon.stderr || '').slice(0, 400)}`)
}
console.log('PASS  three queries, receipts verify, reconcile ran')
