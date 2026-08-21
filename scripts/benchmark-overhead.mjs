#!/usr/bin/env node
/**
 * Conarium overhead vs direct Postgres.
 *
 *   CONARIUM_BENCH_DSN=postgres://… node scripts/benchmark-overhead.mjs
 *
 * Without a DSN this does not invent a comparison. It writes not run
 * for (a) vs (b) and still records in-process gate timings (CPU of
 * guardQuery + redact — not a substitute for the Postgres delta).
 *
 * No extra packages. Node builtins + the `postgres` dependency already
 * in the product, plus `dist/governance.js`.
 *
 *   --out <path>   JSON destination (default: docs/benchmarks/<stamp>.json)
 *   --help
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, platform, release, arch } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)

function has(flag) {
  return ARGS.includes(flag)
}
function valueOf(flag, fallback) {
  const i = ARGS.indexOf(flag)
  if (i < 0) return fallback
  return ARGS[i + 1] ?? fallback
}

if (has('--help') || has('-h')) {
  console.log(`Usage: node scripts/benchmark-overhead.mjs [--out <path>]

Measures Conarium's added cost, not absolute speed.

  (a) the same SELECT against Postgres
  (b) guardQuery → that SELECT (rewritten) → redact

Scenarios: allow (unmasked) · partial (email masked) · deny (query must not run).
Caps: 100 (code default) · 500 · 5 000. Dataset is 5 000 rows.

Needs CONARIUM_BENCH_DSN for (a) vs (b). Without it: not run.`)
  process.exit(0)
}

const govJs = join(root, 'dist', 'governance.js')
if (!existsSync(govJs)) {
  console.error('dist/governance.js missing — run npm run build first')
  process.exit(2)
}

const { Governance, PolicyError } = await import(pathToFileURL(govJs).href)

const DEFAULT_MAX_ROWS = 100
const CAPS = [DEFAULT_MAX_ROWS, 500, 5_000]
const DATASET_ROWS = 5_000
const IN_PROCESS_SIZES = [50, 100, 500, 1_000, 5_000]
const WARMUP_SMALL = 15
const REPEAT_SMALL = 50
const WARMUP_LARGE = 2
const REPEAT_LARGE = 8
const LARGE_AT = 5_000
const QUERY = 'SELECT id, name, email, note FROM public.bench_customers ORDER BY id'
const DENY_QUERY = 'SELECT id, name, email, note FROM public.bench_secrets ORDER BY id'
const SECRET_EMAIL = 'bench-secret-user@example.com'

function budget(n, series) {
  if (series === 'same-sql' || n >= LARGE_AT) {
    return { warmup: 5, repeats: 15 }
  }
  return { warmup: WARMUP_SMALL, repeats: REPEAT_SMALL }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  }
}

function hardware() {
  const list = cpus()
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: list[0]?.model ?? 'unknown',
    cores: list.length,
    ramBytes: totalmem(),
    node: process.version,
  }
}

function stampName() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`
}

function policyFor(kind, maxRows = DEFAULT_MAX_ROWS) {
  if (kind === 'allow') {
    return { allowTables: ['public.bench_customers'], maxRows }
  }
  if (kind === 'partial') {
    return {
      allowTables: ['public.bench_customers'],
      maskColumns: ['*.email'],
      maxRows,
    }
  }
  return {
    allowTables: ['public.bench_customers'],
    denyTables: ['public.bench_secrets'],
    maskColumns: ['*.email'],
    maxRows,
  }
}

function syntheticRows(n, { uniqueEmails = true } = {}) {
  const rows = new Array(n)
  for (let i = 1; i <= n; i++) {
    rows[i - 1] = {
      id: i,
      name: `user-${i}`,
      email: uniqueEmails
        ? (i === 1 ? SECRET_EMAIL : `user-${i}@example.com`)
        : SECRET_EMAIL,
      note: `note ${i}`,
    }
  }
  return rows
}

function timeSync(fn, warmup, repeats, label = '') {
  if (label) process.stderr.write(`  ${label} warmup=${warmup} n=${repeats}\n`)
  for (let i = 0; i < warmup; i++) fn()
  const samples = new Array(repeats)
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now()
    fn()
    samples[i] = performance.now() - t0
    if (label && (i === 0 || i === repeats - 1)) {
      process.stderr.write(`  ${label} sample ${i + 1}/${repeats} ${samples[i].toFixed(1)}ms\n`)
    }
  }
  return samples
}

async function timeAsync(fn, warmup, repeats, label = '') {
  if (label) process.stderr.write(`  ${label} warmup=${warmup} n=${repeats}\n`)
  for (let i = 0; i < warmup; i++) await fn()
  const samples = new Array(repeats)
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now()
    await fn()
    samples[i] = performance.now() - t0
    if (label && (i === 0 || i === repeats - 1)) {
      process.stderr.write(`  ${label} sample ${i + 1}/${repeats} ${samples[i].toFixed(1)}ms\n`)
    }
  }
  return samples
}

function runInProcess() {
  const out = { guard: {}, redact: {}, samples: { guard: {}, redact: {} } }
  for (const kind of ['allow', 'partial', 'deny']) {
    const gov = new Governance(policyFor(kind, DEFAULT_MAX_ROWS))
    const sql = kind === 'deny' ? DENY_QUERY : QUERY
    const { warmup, repeats } = budget(10)
    const samples = timeSync(() => {
      try {
        gov.guardQuery(sql)
      } catch (err) {
        if (kind !== 'deny') throw err
        if (!(err instanceof PolicyError)) throw err
      }
    }, warmup, repeats, `guard ${kind}`)
    out.samples.guard[kind] = samples
    out.guard[kind] = { ...summarize(samples), warmup, repeats, unit: 'ms' }
  }

  const sizes = process.env.CONARIUM_BENCH_DSN
    ? IN_PROCESS_SIZES.filter((n) => n <= 500)
    : IN_PROCESS_SIZES
  for (const n of sizes) {
    const gov = new Governance(policyFor('partial', Math.max(n, DEFAULT_MAX_ROWS)))
    const guarded = gov.guardQuery(QUERY)
    const { warmup, repeats } = budget(n)

    const uniqueRows = syntheticRows(n, { uniqueEmails: true })
    const uniquePayload = {
      rows: uniqueRows,
      rowCount: n,
      fields: ['id', 'name', 'email', 'note'],
      sql: guarded.sql,
    }

    const samples = timeSync(() => {
      gov.redact(uniquePayload, guarded.aliases, guarded.metadata)
    }, warmup, repeats, `redact ${n} unique-email`)
    out.samples.redact[String(n)] = samples
    out.redact[String(n)] = {
      ...summarize(samples),
      warmup,
      repeats,
      unit: 'ms',
      rows: n,
      uniqueEmails: true,
    }
  }
  return out
}

async function ensureBenchTables(sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.bench_customers (
      id integer PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL,
      note text NOT NULL
    )
  `)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.bench_secrets (
      id integer PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL,
      note text NOT NULL
    )
  `)
  const [{ n }] = await sql.unsafe('SELECT count(*)::int AS n FROM public.bench_customers')
  if (n < DATASET_ROWS) {
    await sql.unsafe('TRUNCATE public.bench_customers')
    const batch = 1_000
    for (let start = 1; start <= DATASET_ROWS; start += batch) {
      const end = Math.min(DATASET_ROWS, start + batch - 1)
      const values = []
      for (let i = start; i <= end; i++) {
        const email = i === 1 ? SECRET_EMAIL : `user-${i}@example.com`
        values.push(`(${i}, 'user-${i}', '${email}', 'note ${i}')`)
      }
      await sql.unsafe(
        `INSERT INTO public.bench_customers (id, name, email, note) VALUES ${values.join(',')}`,
      )
    }
  }
  const [{ s }] = await sql.unsafe('SELECT count(*)::int AS s FROM public.bench_secrets')
  if (s < 1) {
    await sql.unsafe(
      `INSERT INTO public.bench_secrets (id, name, email, note) VALUES (1, 'hidden', '${SECRET_EMAIL}', 'secret')`,
    )
  }
}

async function runPostgresComparison(dsn) {
  const postgres = (await import('postgres')).default
  const sql = postgres(dsn, { max: 1, idle_timeout: 5 })
  let queryRuns = 0
  const tracked = async (text) => {
    queryRuns += 1
    return sql.unsafe(text)
  }

  try {
    const [{ version }] = await sql.unsafe('SELECT version()')
    await ensureBenchTables(sql)

    const comparison = {}
    const samples = {}

    for (const series of ['same-sql', 'same-limit']) {
      comparison[series] = {}
      samples[series] = {}
      for (const kind of ['allow', 'partial', 'deny']) {
        comparison[series][kind] = {}
        samples[series][kind] = {}
        for (const cap of CAPS) {
          const gov = new Governance(policyFor(kind, cap))
          const base = kind === 'deny' ? DENY_QUERY : QUERY
          const text = series === 'same-limit' ? `${base} LIMIT ${cap}` : base
          const { warmup, repeats } = budget(cap, series)
          const cellLabel = `${series} ${kind} maxRows=${cap}`

          if (kind === 'deny') {
            const before = queryRuns
            const denySamples = await timeAsync(async () => {
              try {
                gov.guardQuery(text)
                throw new Error('deny scenario allowed the query — not measured as deny')
              } catch (err) {
                if (!(err instanceof PolicyError)) throw err
              }
            }, warmup, repeats, cellLabel)
            if (queryRuns !== before) {
              throw new Error(`deny ran the query ${queryRuns - before} time(s) — gate failed`)
            }
            comparison[series][kind][String(cap)] = {
              direct: null,
              conarium: { ...summarize(denySamples), warmup, repeats, unit: 'ms' },
              overhead: null,
              note: 'deny must not hit Postgres; overhead vs direct is not defined',
              queryRan: false,
              maxRows: cap,
            }
            samples[series][kind][String(cap)] = { conarium: denySamples }
            continue
          }

          const directSamples = await timeAsync(async () => {
            await tracked(text)
          }, warmup, repeats, `${cellLabel} direct`)

          const conariumSamples = []
          const deltas = []
          let lastDirectRows = 0
          let lastConariumRows = 0
          for (let i = 0; i < warmup; i++) {
            const guarded = gov.guardQuery(text)
            const rows = await tracked(guarded.sql)
            gov.redact(
              { rows, rowCount: rows.length, fields: ['id', 'name', 'email', 'note'], sql: guarded.sql },
              guarded.aliases,
              guarded.metadata,
            )
          }
          for (let i = 0; i < repeats; i++) {
            const d0 = performance.now()
            const directRows = await tracked(text)
            const directMs = performance.now() - d0
            lastDirectRows = directRows.length

            const c0 = performance.now()
            const guarded = gov.guardQuery(text)
            const rows = await tracked(guarded.sql)
            const redacted = gov.redact(
              { rows, rowCount: rows.length, fields: ['id', 'name', 'email', 'note'], sql: guarded.sql },
              guarded.aliases,
              guarded.metadata,
            )
            const conariumMs = performance.now() - c0
            lastConariumRows = redacted.rows.length
            if (kind === 'partial') {
              const leaked = redacted.rows.some((row) =>
                Object.values(row).some((v) => typeof v === 'string' && v.includes(SECRET_EMAIL)),
              )
              if (leaked) throw new Error('partial scenario leaked the secret email — numbers discarded')
            }
            conariumSamples.push(conariumMs)
            deltas.push(conariumMs - directMs)
          }

          comparison[series][kind][String(cap)] = {
            direct: { ...summarize(directSamples), warmup, repeats, unit: 'ms', rows: lastDirectRows },
            conarium: { ...summarize(conariumSamples), warmup, repeats, unit: 'ms', rows: lastConariumRows },
            overhead: { ...summarize(deltas), warmup, repeats, unit: 'ms' },
            queryRan: true,
            maxRows: cap,
            userSql: text,
          }
          samples[series][kind][String(cap)] = {
            direct: directSamples,
            conarium: conariumSamples,
            overhead: deltas,
          }
        }
      }
    }

    return { status: 'ran', version, datasetRows: DATASET_ROWS, caps: CAPS, comparison, samples }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const dsn = process.env.CONARIUM_BENCH_DSN || ''
const hw = hardware()
const inProcess = runInProcess()

let postgresResult
if (!dsn) {
  postgresResult = {
    status: 'kosulanmadi',
    reason: 'CONARIUM_BENCH_DSN unset; this machine has no local Postgres in PATH and no Docker',
    version: null,
    comparison: null,
    samples: null,
  }
} else {
  postgresResult = await runPostgresComparison(dsn)
}

const report = {
  measuredAt: new Date().toISOString(),
  hardware: hw,
  method: {
    defaultMaxRows: DEFAULT_MAX_ROWS,
    caps: CAPS,
    datasetRows: DATASET_ROWS,
    inProcessSizes: IN_PROCESS_SIZES,
    warmupSmall: WARMUP_SMALL,
    repeatsSmall: REPEAT_SMALL,
    warmupLarge: WARMUP_LARGE,
    repeatsLarge: REPEAT_LARGE,
    query: QUERY,
    denyQuery: DENY_QUERY,
    headline: 'p50 / p95 / p99 — mean is not reported',
    whatOverheadMeans:
      'overhead = paired (guardQuery + Postgres + redact) minus the same SELECT sent straight to Postgres. same-sql: user SQL has no LIMIT (Conarium adds maxRows). same-limit: user SQL already has LIMIT = maxRows (same row count).',
  },
  postgres: {
    status: postgresResult.status,
    reason: postgresResult.reason ?? null,
    version: postgresResult.version ?? null,
    datasetRows: postgresResult.datasetRows ?? null,
    caps: postgresResult.caps ?? null,
    comparison: postgresResult.comparison,
  },
  inProcess: {
    note: 'Gate CPU only. Not a substitute for the Postgres comparison.',
    guard: inProcess.guard,
    redact: inProcess.redact,
  },
  samples: {
    postgres: postgresResult.samples,
    inProcess: inProcess.samples,
  },
}

const outDir = join(root, 'docs', 'benchmarks')
mkdirSync(outDir, { recursive: true })
const defaultOut = join(outDir, `overhead-${stampName()}-${platform()}.json`)
const outPath = valueOf('--out', defaultOut)
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n')

function line(label, stats) {
  if (!stats || stats.p50 == null) return `${label}: (yok)`
  const f = (x) => (typeof x === 'number' ? x.toFixed(3) : String(x))
  return `${label}: p50=${f(stats.p50)} p95=${f(stats.p95)} p99=${f(stats.p99)} ms (n=${stats.n})`
}

console.log(`hardware  ${hw.cpu} × ${hw.cores}  RAM=${Math.round(hw.ramBytes / 1e9)}GB  ${hw.platform} ${hw.release}  node ${hw.node}`)
console.log(`postgres  ${postgresResult.status}${postgresResult.reason ? ` — ${postgresResult.reason}` : ''}`)
if (postgresResult.version) console.log(`pg        ${postgresResult.version}`)
console.log('')
if (postgresResult.comparison) {
  for (const series of Object.keys(postgresResult.comparison)) {
    for (const kind of Object.keys(postgresResult.comparison[series])) {
      for (const cap of Object.keys(postgresResult.comparison[series][kind])) {
        const cell = postgresResult.comparison[series][kind][cap]
        const rows = cell.direct?.rows != null ? ` directRows=${cell.direct.rows} conariumRows=${cell.conarium?.rows}` : ''
        console.log(`[${series} ${kind} maxRows=${cap}${rows}]`)
        console.log('  ' + line('direct   ', cell.direct))
        console.log('  ' + line('conarium ', cell.conarium))
        console.log('  ' + line('overhead ', cell.overhead))
      }
    }
  }
} else {
  console.log('Postgres comparison: not run')
}
console.log('')
console.log('in-process (not vs Postgres)')
for (const kind of Object.keys(inProcess.guard)) {
  console.log('  ' + line(`guard ${kind.padEnd(8)}`, inProcess.guard[kind]))
}
for (const n of Object.keys(inProcess.redact)) {
  const cell = inProcess.redact[n]
  if (cell.status === 'kosulanmadi') {
    console.log(`  redact ${n}: not run — ${cell.reason}`)
  } else {
    console.log('  ' + line(`redact ${String(n).padStart(6)}`, cell))
  }
}
console.log('')
console.log(`wrote ${outPath}`)
process.exit(postgresResult.status === 'ran' || postgresResult.status === 'kosulanmadi' ? 0 : 1)
