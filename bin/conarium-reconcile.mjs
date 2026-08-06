#!/usr/bin/env node
/**
 * conarium-reconcile — two-sided coverage: reconcile the database's own query
 * counters against Conarium receipts over a time window.
 *
 * The question this answers is the one receipts alone cannot:
 *   "the database recorded query activity — is every bit of it receipted?"
 * A pattern the DB counted but no receipt covers means access was RECORDED by
 * the data source but NOT RECEIPTED by Conarium — the gateway may have been
 * bypassed, or the receipt sink failed. The tool reports that fact; it does
 * not claim intent.
 *
 * ZERO imports from src/. A third party must be able to run this single file
 * without the Conarium package.
 *
 * Inputs:
 *   --before <snapshot.json>   DB counter snapshot at window start
 *   --after  <snapshot.json>   DB counter snapshot at window end
 *   --receipts <receipts.jsonl>
 *
 * Snapshot schema (conarium-dbsnapshot/0.1) — produced by scripts/pg-snapshot.sql:
 *   { "v": "conarium-dbsnapshot/0.1", "ts": ISO8601, "role": "conarium_c2",
 *     "source": "pg_stat_statements", "entries": [ { "queryid": "…", "query": "…", "calls": 76 } ] }
 *
 * Honesty rules (same discipline as the coverage declaration):
 *   - Absence of a receipt is reported as "NOT RECEIPTED", never as proof of intent.
 *   - Matching is per query PATTERN and per TABLE, never per call count: one
 *     REST request may produce more than one SQL statement (PostgREST), so
 *     call counts and receipt counts are NOT compared 1:1.
 *   - A pattern whose target table cannot be determined is NOT silently
 *     cleared — it fails the reconciliation with its own message.
 *   - Receipt signatures are NOT checked here. Run conarium-verify first;
 *     this tool assumes the receipts file is already verified.
 *
 * Exit codes (documented in docs/RECEIPT-SPEC.md):
 *   0   every DB query pattern in the window is covered by receipts
 *   20  input invalid or window unreliable (schema error, role mismatch,
 *       counter regression — e.g. pg_stat_statements was reset mid-window)
 *   40  unreconciled DB activity: at least one pattern the DB recorded has no
 *       covering receipt in the window (or could not be attributed to a table)
 */
import { readFileSync, existsSync } from 'fs'

const RECONCILE_V = 'conarium-reconcile/0.1'
const SNAPSHOT_V = 'conarium-dbsnapshot/0.1'

// ─── snapshot loading ────────────────────────────────────────────────────────

function loadSnapshot(path, label) {
  if (!existsSync(path)) {
    return { error: `${label} snapshot not found: ${path}` }
  }
  let obj
  try {
    obj = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { error: `${label} snapshot is not valid JSON: ${err.message}` }
  }
  if (!obj || typeof obj !== 'object') return { error: `${label} snapshot: not an object` }
  if (obj.v !== SNAPSHOT_V) {
    return { error: `${label} snapshot: unsupported version ${JSON.stringify(obj.v)} (expected ${SNAPSHOT_V})` }
  }
  if (typeof obj.ts !== 'string' || Number.isNaN(Date.parse(obj.ts))) {
    return { error: `${label} snapshot: ts missing or not ISO-8601` }
  }
  if (typeof obj.role !== 'string' || !obj.role) return { error: `${label} snapshot: missing role` }
  if (typeof obj.source !== 'string' || !obj.source) return { error: `${label} snapshot: missing source` }
  if (!Array.isArray(obj.entries)) return { error: `${label} snapshot: entries must be an array` }
  const entries = new Map()
  for (const e of obj.entries) {
    if (!e || typeof e !== 'object') return { error: `${label} snapshot: entry is not an object` }
    const qid = typeof e.queryid === 'number' ? String(e.queryid) : e.queryid
    if (typeof qid !== 'string' || !qid) return { error: `${label} snapshot: entry missing queryid` }
    if (typeof e.query !== 'string') return { error: `${label} snapshot: entry ${qid} missing query text` }
    if (!Number.isInteger(e.calls) || e.calls < 0) {
      return { error: `${label} snapshot: entry ${qid} calls must be a non-negative integer` }
    }
    if (entries.has(qid)) return { error: `${label} snapshot: duplicate queryid ${qid}` }
    entries.set(qid, { queryid: qid, query: e.query, calls: e.calls })
  }
  return { snapshot: { v: obj.v, ts: obj.ts, role: obj.role, source: obj.source, entries } }
}

// ─── SQL pattern → table attribution ────────────────────────────────────────

/**
 * Extract referenced relations from a (normalized) SQL pattern text.
 * Returns [{schema|null, table}]. Best-effort by design: anything this cannot
 * attribute is reported as UNATTRIBUTED and fails the reconciliation — it is
 * never silently cleared.
 */
export function extractTables(sql) {
  const found = []
  const seen = new Set()
  // CTE adları (WITH x AS (…)) ilişki değildir — PostgREST her sorguyu
  // `WITH pgrst_source AS (…) SELECT … FROM pgrst_source` diye sarar; CTE adı
  // tablo sanılırsa her PostgREST deseni sahte "unreconciled" üretir.
  const cteNames = new Set()
  const cteRe = /("([^"]+)"|[a-z_][a-z0-9_$]*)\s+as\s*\(/gi
  let c
  while ((c = cteRe.exec(sql)) !== null) {
    const name = c[2] !== undefined ? c[2] : c[1]
    cteNames.add(name.toLowerCase())
  }
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?("([^"]+)"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*("([^"]+)"|[a-z_][a-z0-9_$]*))?/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    const first = m[2] !== undefined ? m[2] : m[1]
    const second = m[3] === undefined ? null : m[4] !== undefined ? m[4] : m[3]
    let schema = null
    let table
    if (second !== null) {
      schema = first
      table = second
    } else {
      table = first
    }
    // `from (select …)` gives no name; regex already requires an identifier.
    // Skip obvious keywords that can follow FROM in some dialects.
    if (/^(select|values|lateral|unnest)$/i.test(table)) continue
    if (schema === null && cteNames.has(table.toLowerCase())) continue
    const key = `${schema ?? ''}.${table}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ schema: schema ? schema.toLowerCase() : null, table: table.toLowerCase() })
  }
  return found
}

const INFRA_SCHEMAS = new Set(['pg_catalog', 'information_schema'])
const INFRA_QUERY_RE = /^\s*(set\b|show\b|begin\b|commit\b|rollback\b|select\s+set_config\b|deallocate\b|discard\b)/i

/**
 * Classify one DB pattern with a positive call delta.
 *  - 'infrastructure'  session/catalog housekeeping (SET, pg_catalog, information_schema)
 *  - 'unattributed'    no table could be determined — NOT cleared
 *  - 'data'            touches at least one user relation
 */
export function classifyPattern(query) {
  if (INFRA_QUERY_RE.test(query)) return { kind: 'infrastructure', tables: [] }
  const tables = extractTables(query)
  if (tables.length === 0) return { kind: 'unattributed', tables: [] }
  const userTables = tables.filter(
    (t) => !(t.schema && INFRA_SCHEMAS.has(t.schema)) && !(t.schema === null && t.table.startsWith('pg_')),
  )
  if (userTables.length === 0) return { kind: 'infrastructure', tables }
  return { kind: 'data', tables: userTables }
}

// ─── receipts ────────────────────────────────────────────────────────────────

function loadReceipts(path) {
  if (!existsSync(path)) return { error: `receipts file not found: ${path}` }
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return { receipts: [] }
  const receipts = []
  const lines = raw.split('\n').filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch (err) {
      return { error: `receipts line ${i + 1}: invalid JSON: ${err.message}` }
    }
    if (!r || typeof r !== 'object' || typeof r.ts !== 'string') {
      return { error: `receipts line ${i + 1}: missing ts` }
    }
    receipts.push(r)
  }
  return { receipts }
}

/** Son nokta-parçası: "zion.customers" → "customers". Şema önekleri bağlayıcı farklı adlandırır. */
function normalizeObject(name) {
  const parts = String(name).toLowerCase().split('.')
  return parts[parts.length - 1]
}

/**
 * Collect the set of tables the in-window receipts cover.
 * Same attribution rule as src/coverage.ts computeCoverage:
 * dataRefs[].object + describe_table's request.target. list_tables is schema
 * listing, not data access. Receipts with no attributable object are counted —
 * their presence makes any "not receipted" finding NOT definitive.
 */
export function receiptCoverage(receipts, fromMs, toMs) {
  const covered = new Set() // normalized table names
  const coveredRaw = new Set() // raw object names for reporting
  let inWindow = 0
  let outOfWindow = 0
  let unassigned = 0
  for (const r of receipts) {
    const t = Date.parse(r.ts)
    if (Number.isNaN(t) || t < fromMs || t > toMs) {
      outOfWindow++
      continue
    }
    inWindow++
    let hasObject = false
    for (const ref of r.dataRefs || []) {
      covered.add(normalizeObject(ref.object))
      coveredRaw.add(String(ref.object))
      hasObject = true
    }
    if (r.request?.tool === 'describe_table' && r.request?.target) {
      covered.add(normalizeObject(r.request.target))
      coveredRaw.add(String(r.request.target))
      hasObject = true
    }
    if (!hasObject && (r.request?.tool === 'query' || r.request?.tool === 'search')) {
      unassigned++
    }
  }
  return { covered, coveredRaw, inWindow, outOfWindow, unassigned }
}

// ─── reconciliation core ─────────────────────────────────────────────────────

export function reconcile(before, after, receipts) {
  if (before.role !== after.role) {
    return { error: `role mismatch: before=${before.role}, after=${after.role}` }
  }
  if (before.source !== after.source) {
    return { error: `source mismatch: before=${before.source}, after=${after.source}` }
  }
  const fromMs = Date.parse(before.ts)
  const toMs = Date.parse(after.ts)
  if (toMs <= fromMs) {
    return { error: `window is empty or inverted: before.ts=${before.ts}, after.ts=${after.ts}` }
  }

  // Per-pattern call delta. A queryid new in `after` counts in full.
  const deltas = []
  for (const [qid, e] of after.entries) {
    const prev = before.entries.get(qid)
    const prevCalls = prev ? prev.calls : 0
    if (e.calls < prevCalls) {
      return {
        error:
          `counter regression on queryid ${qid} (before=${prevCalls}, after=${e.calls}) — ` +
          `${after.source} was likely reset mid-window; the window is unreliable, take fresh snapshots`,
      }
    }
    const delta = e.calls - prevCalls
    if (delta > 0) deltas.push({ queryid: qid, query: e.query, delta })
  }
  // A queryid present before but absent after ALSO means a reset (eviction is
  // possible under pressure, but silently assuming that would hide resets).
  for (const [qid, e] of before.entries) {
    if (!after.entries.has(qid)) {
      return {
        error:
          `queryid ${qid} present in before but missing in after (calls=${e.calls}) — ` +
          `${after.source} was likely reset or evicted mid-window; the window is unreliable`,
      }
    }
  }

  const cov = receiptCoverage(receipts, fromMs, toMs)

  const reconciled = []
  const unreconciled = []
  const unattributed = []
  const infrastructure = []
  for (const d of deltas) {
    const cls = classifyPattern(d.query)
    if (cls.kind === 'infrastructure') {
      infrastructure.push(d)
      continue
    }
    if (cls.kind === 'unattributed') {
      unattributed.push(d)
      continue
    }
    const uncovered = cls.tables.filter((t) => !cov.covered.has(t.table))
    if (uncovered.length === 0) {
      reconciled.push({ ...d, tables: cls.tables.map((t) => t.table) })
    } else {
      unreconciled.push({ ...d, uncoveredTables: uncovered.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table)) })
    }
  }

  return {
    v: RECONCILE_V,
    window: { start: before.ts, end: after.ts },
    role: before.role,
    source: before.source,
    db: { patternsWithActivity: deltas.length, totalNewCalls: deltas.reduce((s, d) => s + d.delta, 0) },
    receipts: {
      inWindow: cov.inWindow,
      outOfWindow: cov.outOfWindow,
      unassigned: cov.unassigned,
      coveredObjects: [...cov.coveredRaw].sort(),
    },
    reconciled,
    unreconciled,
    unattributed,
    infrastructure,
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-reconcile --before <snapshot.json> --after <snapshot.json> --receipts <receipts.jsonl> [--json]',
  )
}

function parseArgs(argv) {
  const out = { before: null, after: null, receiptsPath: null, json: false }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--before') {
      out.before = args.shift() ?? null
      if (!out.before) throw new Error('--before requires a path')
    } else if (a === '--after') {
      out.after = args.shift() ?? null
      if (!out.after) throw new Error('--after requires a path')
    } else if (a === '--receipts') {
      out.receiptsPath = args.shift() ?? null
      if (!out.receiptsPath) throw new Error('--receipts requires a path')
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--help' || a === '-h') {
      usage()
      process.exit(0)
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  return out
}

function fail(code, message, jsonMode, extra = {}) {
  console.error(message)
  if (jsonMode) console.log(JSON.stringify({ ok: false, code, message, ...extra }))
  process.exit(code)
}

function truncate(s, n = 110) {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    usage(err.message)
    process.exit(20)
  }
  if (!opts.before || !opts.after || !opts.receiptsPath) {
    usage('missing required flag (--before, --after and --receipts are all required)')
    process.exit(20)
  }

  const b = loadSnapshot(opts.before, 'before')
  if (b.error) fail(20, b.error, opts.json)
  const a = loadSnapshot(opts.after, 'after')
  if (a.error) fail(20, a.error, opts.json)
  const rec = loadReceipts(opts.receiptsPath)
  if (rec.error) fail(20, rec.error, opts.json)

  const result = reconcile(b.snapshot, a.snapshot, rec.receipts)
  if (result.error) fail(20, result.error, opts.json)

  const problems = result.unreconciled.length + result.unattributed.length

  if (opts.json) {
    console.log(JSON.stringify({ ok: problems === 0, code: problems === 0 ? 0 : 40, ...result }))
  } else {
    console.log(
      `reconcile window: ${result.window.start} → ${result.window.end} ` +
        `(role ${result.role}, source ${result.source})`,
    )
    console.log(
      `db: +${result.db.totalNewCalls} call(s) across ${result.db.patternsWithActivity} pattern(s) · ` +
        `receipts in window: ${result.receipts.inWindow} · out of window: ${result.receipts.outOfWindow}`,
    )
    console.log(
      'note: matching is per pattern and per table, never per call count — one request may produce more than one statement',
    )
    console.error('note: receipt signatures are NOT checked here — run conarium-verify first')
    if (result.infrastructure.length > 0) {
      console.log(`infrastructure pattern(s) (session/catalog housekeeping, not data access): ${result.infrastructure.length}`)
      for (const d of result.infrastructure) console.log(`  ~ (+${d.delta}) ${truncate(d.query)}`)
    }
    for (const d of result.reconciled) {
      console.log(`  = (+${d.delta}) covered by receipt(s) for [${d.tables.join(', ')}]: ${truncate(d.query)}`)
    }
    if (result.receipts.unassigned > 0) {
      console.warn(
        `warning: ${result.receipts.unassigned} receipt(s) in the window could not be attributed to a table — ` +
          `any "not receipted" finding below is NOT definitive`,
      )
    }
    if (problems === 0) {
      console.log('ok: every DB query pattern in the window is covered by receipts')
    } else {
      if (result.unreconciled.length > 0) {
        console.error(
          `UNRECONCILED: ${result.unreconciled.length} pattern(s) recorded by the database have no covering receipt in the window:`,
        )
        for (const d of result.unreconciled) {
          console.error(`  ! (+${d.delta}) table(s) [${d.uncoveredTables.join(', ')}]: ${truncate(d.query)}`)
        }
      }
      if (result.unattributed.length > 0) {
        console.error(
          `UNATTRIBUTED: ${result.unattributed.length} pattern(s) could not be attributed to a table — not cleared:`,
        )
        for (const d of result.unattributed) console.error(`  ? (+${d.delta}) ${truncate(d.query)}`)
      }
      console.error(
        'this means access was RECORDED by the database but NOT RECEIPTED by Conarium in this window — ' +
          'the gateway may have been bypassed, or the receipt sink failed. It does not by itself prove intent.',
      )
    }
  }
  // Literal çıkışlar bilerek ayrı: spec_exitcode_drift bekçisi sadece
  // literal sayıları tarar, ternary içindeki kod görünmez kalırdı.
  if (problems === 0) {
    process.exit(0)
  }
  process.exit(40)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('conarium-reconcile.mjs') || process.argv[1].endsWith('conarium-reconcile'))

if (isDirect) {
  main().catch((err) => {
    console.error(err)
    process.exit(20)
  })
}
