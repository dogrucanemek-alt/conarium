/**
 * In-process concurrency + audit-chain race. Does not touch Hetzner.
 * Hardware is recorded with the numbers. Not a formal load test.
 */
import { cpus, totalmem, platform, release } from 'os'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from '../dist/server.js'
import { Audit } from '../dist/audit.js'
import { Governance } from '../dist/governance.js'

const N = Number(process.env.CONARIUM_BENCH_N || 50)
const PREV = process.env.CONARIUM_AUDIT_UNSIGNED
process.env.CONARIUM_AUDIT_UNSIGNED = '1'

const conn = {
  name: 'mem',
  description: 'concurrency fixture',
  capabilities: { canQuery: true, canListSchema: false, canDescribeTable: false, canSearch: false },
  connect: async () => {},
  disconnect: async () => {},
  listTables: async () => [],
  describeTable: async (t) => ({ name: t, schema: 'public', columns: [] }),
  query: async (sql) => {
    await new Promise((r) => setImmediate(r))
    return { rows: [{ id: 1, email: 'a@b.com' }], rowCount: 1, fields: ['id', 'email'] }
  },
  search: async () => ({ rows: [], rowCount: 0, fields: [] }),
}

const dir = mkdtempSync(join(tmpdir(), 'conarium-conc-'))
const sink = join(dir, 'audit.jsonl')
const deps = {
  config: { serverName: 'bench', consumer: 'conc', connectors: [] },
  governance: new Governance({
    allowConnectors: ['mem'],
    allowTables: ['public.customers'],
    maskColumns: ['*.email'],
    maxRows: 50,
    dialect: 'postgres',
  }),
  audit: new Audit({ consumer: 'conc', sink }),
  connectors: [conn],
}
const server = buildServer(deps)
const handlers = server._requestHandlers
const call = handlers.get(CallToolRequestSchema.shape.method.value)

function pct(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[i]
}

const t0 = process.hrtime.bigint()
const heap0 = process.memoryUsage()
const started = Date.now()
const results = await Promise.all(
  Array.from({ length: N }, async () => {
    const a = process.hrtime.bigint()
    const out = await call({
      method: 'tools/call',
      params: { name: 'query', arguments: { sql: 'SELECT id, email FROM public.customers' } },
    })
    const ms = Number(process.hrtime.bigint() - a) / 1e6
    return { ms, isError: Boolean(out.isError) }
  }),
)
const wallMs = Date.now() - started
const heap1 = process.memoryUsage()

const times = results.map((r) => r.ms).sort((a, b) => a - b)
const errors = results.filter((r) => r.isError).length
const lines = readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const prevBreaks = []
for (let i = 1; i < lines.length; i++) {
  if (lines[i].prevHash !== lines[i - 1].hash) prevBreaks.push(i + 1)
}

const auditA = new Audit({ consumer: 'race-a', sink: join(dir, 'race.jsonl') })
const auditB = new Audit({ consumer: 'race-b', sink: join(dir, 'race.jsonl') })
// Two instances, interleaved only at await boundaries — log() itself is sync.
await Promise.all([
  (async () => { await new Promise((r) => setImmediate(r)); auditA.log({ tool: 'q', denied: false }) })(),
  (async () => { await new Promise((r) => setImmediate(r)); auditB.log({ tool: 'q', denied: false }) })(),
])
const raceLines = readFileSync(join(dir, 'race.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const raceBreaks = []
for (let i = 1; i < raceLines.length; i++) {
  if (raceLines[i].prevHash !== raceLines[i - 1].hash) raceBreaks.push(i + 1)
}

const huge = await call({
  method: 'tools/call',
  params: { name: 'query', arguments: { sql: 'SELECT ' + 'x,'.repeat(200) + 'id FROM public.customers' } },
})

const report = {
  when: new Date().toISOString(),
  hardware: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    ramBytes: totalmem(),
    os: `${platform()} ${release()}`,
    node: process.version,
  },
  n: N,
  wallMs,
  latencyMs: { p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), min: times[0], max: times[times.length - 1] },
  errorRate: errors / N,
  chain: { entries: lines.length, prevHashBreaks: prevBreaks },
  twoInstanceRace: { entries: raceLines.length, prevHashBreaks: raceBreaks },
  heap: {
    heapUsed0: heap0.heapUsed,
    heapUsed1: heap1.heapUsed,
    delta: heap1.heapUsed - heap0.heapUsed,
  },
  hugeSql: { isError: Boolean(huge.isError), preview: String(huge.content?.[0]?.text || '').slice(0, 120) },
  elapsedNs: Number(process.hrtime.bigint() - t0),
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'benchmarks')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'concurrency-20260814.json')
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
console.log(`wrote ${outPath}`)

if (PREV === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
else process.env.CONARIUM_AUDIT_UNSIGNED = PREV
