#!/usr/bin/env node
/**
 * conarium-reconcile — two-sided coverage: reconcile the database's own query
 * counters against Conarium receipts over a time window.
 *
 * The question this answers is the one receipts alone cannot:
 *   "the database recorded query activity — is any of it not receipted at all?"
 * A pattern the DB counted but no receipt names means access was RECORDED by
 * the data source but NOT RECEIPTED by Conarium — the gateway may have been
 * bypassed, or the receipt sink failed. The tool reports that fact; it does
 * not claim intent.
 *
 * What a clean run establishes is object attribution within the window: every
 * counted pattern names a table for which a receipt exists in the same window.
 * It does NOT establish that each recorded statement was itself receipted —
 * one receipt naming a table clears any number of further statements against
 * that table inside the window. See LIMITATIONS.md.
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
 *   - A clean result is stated as object attribution, never as "covered":
 *     the procedure establishes overlap, not that every statement was
 *     receipted. Claiming the latter would overstate what was checked.
 *   - Receipt signatures are NOT checked here. Run conarium-verify first;
 *     this tool assumes the receipts file is already verified.
 *
 * Exit codes (documented in docs/RECEIPT-SPEC.md):
 *   0   every DB query pattern in the window is attributable to receipt(s) for
 *       the same table — object attribution, not per-statement coverage
 *   20  input invalid or window unreliable (schema error, role mismatch,
 *       counter regression — e.g. pg_stat_statements was reset mid-window)
 *   40  unreconciled DB activity: at least one pattern the DB recorded has no
 *       covering receipt in the window (or could not be attributed to a table)
 *   41  indeterminate: the only thing standing between a pattern and its
 *       receipt is the window boundary, and two clocks decide that boundary
 *
 * Two clocks, one window:
 *   The window is [before.ts, after.ts] and both come from the database. A
 *   receipt's ts comes from the gateway. Admitting a receipt on an exact
 *   comparison across those two clocks makes the failure asymmetric: a gateway
 *   trailing the database turns a receipt that genuinely covers a table into an
 *   out-of-window receipt, the table into an uncovered one, and the run into an
 *   accusation of bypass. Skew then manufactures the accusation rather than any
 *   real gap — and the sub-second version of that is the dangerous one, because
 *   it is believed.
 *
 *   This tool already counted those receipts (`outOfWindow`). What was missing
 *   was not the observation but its qualification: how far outside, and against
 *   what declared bound. A pattern that is uncovered ONLY because a receipt sat
 *   outside the boundary is now indeterminate, not an accusation, and the
 *   report names the skew that would have to be true for it to be one.
 *
 *   `--skew` or Mapping Profile `clocks.skew` declares the bound. Without
 *   either, nothing decides the question, so nothing is asserted: the pattern
 *   is indeterminate and the report says the bound was never declared. With
 *   a bound, a receipt further out than it is not skew, and the pattern
 *   stays unreconciled. If both declarations are present and they disagree,
 *   the run fails rather than picking one.
 *
 *   Reported for the operator, not resolved for them: this tool cannot tell a
 *   trailing clock from a receipt written late. That is why the class is
 *   "indeterminate" and not "covered".
 */
import { createHash } from 'crypto'
import { readFileSync, existsSync, writeFileSync } from 'fs'

const RECONCILE_V = 'conarium-reconcile/0.1'
const SNAPSHOT_V = 'conarium-dbsnapshot/0.1'
const RESULT_V2 = 'coverage-reconciliation/2'
const PROFILE_V = 'conarium-mapping-profile/0.1'

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

/**
 * For every table named by a receipt that fell OUTSIDE the window, the smallest
 * distance from that receipt to the nearest window boundary.
 *
 * This is the qualification the tool was missing. `outOfWindow` counted these
 * receipts; nothing asked how far outside they were, so a receipt three seconds
 * early and one six hours early produced the same verdict.
 */
export function outsideBoundaryCoverage(receipts, fromMs, toMs) {
  const byTable = new Map() // normalized table -> smallest offset in ms
  for (const r of receipts) {
    const t = Date.parse(r.ts)
    if (Number.isNaN(t)) continue
    if (t >= fromMs && t <= toMs) continue
    const offset = t < fromMs ? fromMs - t : t - toMs
    const named = []
    for (const ref of r.dataRefs || []) if (ref.object) named.push(String(ref.object))
    if (r.request?.tool === 'describe_table' && r.request?.target) named.push(String(r.request.target))
    for (const obj of named) {
      const key = normalizeObject(obj)
      const prev = byTable.get(key)
      if (prev === undefined || offset < prev) byTable.set(key, offset)
    }
  }
  return byTable
}

/**
 * Receipts in the window that name an object the database counters did not
 * increment. Distinct from `unassigned` (receipt named nothing).
 *
 * Not a verdict. A stats reset at the window edge, a pooler, or a delayed
 * count can produce the same shape. Reported, not failed — whether this
 * should change the exit code is a later decision, not an omission.
 */
export function unobservedReceipts(receipts, fromMs, toMs, observedTables) {
  const found = []
  for (const r of receipts) {
    const t = Date.parse(r.ts)
    if (Number.isNaN(t) || t < fromMs || t > toMs) continue
    const named = []
    for (const ref of r.dataRefs || []) {
      if (ref.object) named.push(String(ref.object))
    }
    if (r.request?.tool === 'describe_table' && r.request?.target) {
      named.push(String(r.request.target))
    }
    if (named.length === 0) continue
    const noneObserved = named.every((obj) => !observedTables.has(normalizeObject(obj)))
    if (noneObserved) {
      found.push({
        objects: named,
        tool: r.request?.tool || null,
        ts: r.ts,
      })
    }
  }
  return found
}

// ─── reconciliation core ─────────────────────────────────────────────────────

export function reconcile(before, after, receipts, opts = {}) {
  const declaredSkewMs =
    typeof opts.skewMs === 'number' && Number.isFinite(opts.skewMs) && opts.skewMs >= 0
      ? opts.skewMs
      : null
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

  const outside = outsideBoundaryCoverage(receipts, fromMs, toMs)

  const reconciled = []
  const unreconciled = []
  const indeterminate = []
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
      continue
    }
    const names = uncovered.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table))

    // A pattern moves out of the accusation only if the boundary is the ONLY
    // thing missing: every uncovered table must have a receipt just outside.
    // One table with no receipt anywhere is a real gap, and a real gap is not
    // made indeterminate by a neighbour's clock.
    const offsets = uncovered.map((t) => outside.get(t.table))
    const allExplained = offsets.every((o) => o !== undefined)
    const requiredSkewMs = allExplained ? Math.max(...offsets) : null
    const withinDeclared = declaredSkewMs === null || requiredSkewMs <= declaredSkewMs

    if (allExplained && withinDeclared) {
      // Whether the boundary can plausibly explain the gap at all. A receipt
      // further outside than the window is long is not sitting at the boundary;
      // it is in a different window. Attacked on 2026-08-17: a legitimate
      // receipt from the previous day turned a real in-window bypass from 40
      // into 41, and the run then said the access was "NOT reported as
      // unreceipted access" — an exculpation 23 hours of offset cannot support.
      //
      // The threshold is the window's own length, so it is derived from the
      // input rather than chosen. A declared skew bound (--skew or
      // Mapping Profile clocks.skew) is the operator's own statement about
      // their clocks and outranks it.
      const boundaryPlausible = declaredSkewMs !== null || requiredSkewMs <= toMs - fromMs
      indeterminate.push({ ...d, uncoveredTables: names, requiredSkewMs, boundaryPlausible })
    } else {
      unreconciled.push({ ...d, uncoveredTables: names })
    }
  }

  const observedTables = new Set()
  for (const d of deltas) {
    const cls = classifyPattern(d.query)
    if (cls.kind !== 'data') continue
    for (const t of cls.tables) observedTables.add(t.table)
  }
  const unobserved = unobservedReceipts(receipts, fromMs, toMs, observedTables)

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
    clocks: {
      window: before.source,
      receipts: 'gateway',
      declaredSkewMs,
      windowMs: toMs - fromMs,
    },
    reconciled,
    unreconciled,
    indeterminate,
    unattributed,
    infrastructure,
    unobserved,
  }
}

// ─── /2 projection ───────────────────────────────────────────────────────────
//
// A separate object. The /1 JSON and the exit codes are a compatibility
// contract; a consumer MUST NOT read them as this. Draft
// draft-dogru-scitt-disclosure-evidence-04 §Result statement.

function sha256Of(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}

function patternDigest(query) {
  return sha256Of(Buffer.from(String(query), 'utf8'))
}

/**
 * Mapping Profile as the draft names it: operator-declared bounds, versioned,
 * digested. Absent a profile, every multiplicity-dependent item is
 * indeterminate — this function does not invent a bound of one.
 */
export function loadMappingProfile(path) {
  if (!existsSync(path)) return { error: `profile not found: ${path}` }
  const raw = readFileSync(path)
  let obj
  try {
    obj = JSON.parse(raw.toString('utf8'))
  } catch (err) {
    return { error: `profile is not valid JSON: ${err.message}` }
  }
  if (!obj || typeof obj !== 'object') return { error: 'profile: not an object' }
  if (obj.v !== PROFILE_V) {
    return { error: `profile: unsupported version ${JSON.stringify(obj.v)} (expected ${PROFILE_V})` }
  }
  if (typeof obj.version !== 'string' || !obj.version) {
    return { error: 'profile: missing version identifier' }
  }
  let maxStatementsPerReceipt = null
  if (obj.multiplicity != null) {
    if (typeof obj.multiplicity !== 'object') return { error: 'profile: multiplicity must be an object' }
    const n = obj.multiplicity.maxStatementsPerReceipt
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'profile: multiplicity.maxStatementsPerReceipt must be a positive integer' }
    }
    maxStatementsPerReceipt = n
  }
  const exclusions = []
  if (obj.exclusions != null) {
    if (!Array.isArray(obj.exclusions)) return { error: 'profile: exclusions must be an array' }
    for (const e of obj.exclusions) {
      if (!e || typeof e.id !== 'string' || !e.id) return { error: 'profile: exclusion missing id' }
      if (typeof e.version !== 'string' || !e.version) return { error: 'profile: exclusion missing version' }
      exclusions.push({ id: e.id, version: e.version })
    }
  }
  const clocks = { observation: null, receipt: null, skew: null, skewMs: null }
  if (obj.clocks != null) {
    if (typeof obj.clocks !== 'object' || Array.isArray(obj.clocks)) {
      return { error: 'profile: clocks must be an object' }
    }
    for (const key of Object.keys(obj.clocks)) {
      if (key !== 'observation' && key !== 'receipt' && key !== 'skew') {
        return { error: `profile: clocks has unknown field ${JSON.stringify(key)} (expected observation, receipt, skew)` }
      }
    }
    if (obj.clocks.observation != null) {
      if (typeof obj.clocks.observation !== 'string' || !obj.clocks.observation) {
        return { error: 'profile: clocks.observation must be a non-empty string' }
      }
      clocks.observation = obj.clocks.observation
    }
    if (obj.clocks.receipt != null) {
      if (typeof obj.clocks.receipt !== 'string' || !obj.clocks.receipt) {
        return { error: 'profile: clocks.receipt must be a non-empty string' }
      }
      clocks.receipt = obj.clocks.receipt
    }
    if (obj.clocks.skew != null) {
      if (typeof obj.clocks.skew !== 'string' || !obj.clocks.skew) {
        return { error: 'profile: clocks.skew must be a duration string (e.g. 500ms, 5s, 2m, 1h)' }
      }
      const ms = parseDuration(obj.clocks.skew)
      if (ms === null) {
        return { error: `profile: clocks.skew cannot read "${obj.clocks.skew}" as a duration (try 500ms, 5s, 2m, 1h)` }
      }
      clocks.skew = obj.clocks.skew
      clocks.skewMs = ms
    }
  }
  return {
    profile: {
      version: obj.version,
      maxStatementsPerReceipt,
      exclusions,
      clocks,
    },
    raw,
  }
}

/**
 * `--skew` and `clocks.skew` are both operator declarations. If both are
 * present and they do not parse to the same number of milliseconds, the run
 * fails — silently preferring either would hide which bound the result used.
 * Equal values (including `5s` and `5000`) are the same declaration.
 */
export function resolveDeclaredSkew(flagMs, profileSkewMs) {
  const flag = typeof flagMs === 'number' && Number.isFinite(flagMs) ? flagMs : null
  const fromProfile = typeof profileSkewMs === 'number' && Number.isFinite(profileSkewMs) ? profileSkewMs : null
  if (flag != null && fromProfile != null && flag !== fromProfile) {
    return {
      error:
        `--skew (${flag}ms) conflicts with Mapping Profile clocks.skew (${fromProfile}ms); ` +
        'both are operator declarations and this tool will not pick one',
    }
  }
  return { skewMs: flag ?? fromProfile }
}

function infraRuleId(query) {
  return INFRA_QUERY_RE.test(query) ? 'infra-query' : 'infra-schema'
}

/**
 * Project a /1 reconcile() result onto coverage-reconciliation/2.
 * Does not change /1 fields or exit codes.
 */
export function projectResultV2(result, ctx) {
  const profile = ctx.profile ?? null
  const items = []
  const counts = {
    matched: 0,
    excluded: 0,
    'observed-without-receipt': 0,
    'receipted-without-observation': 0,
    indeterminate: 0,
  }

  const push = (outcome, extra) => {
    counts[outcome] += 1
    if (outcome !== 'matched') items.push({ outcome, ...extra })
  }

  const declaredExclusions = profile?.exclusions || []
  const exclusionIds = new Set(declaredExclusions.map((e) => e.id))
  const exclusionBoundDeclared = declaredExclusions.length > 0

  for (const d of result.infrastructure) {
    const id = infraRuleId(d.query)
    if (!profile) {
      push('indeterminate', { pattern: patternDigest(d.query), reason: 'exclusion-undeclared' })
      continue
    }
    if (!exclusionIds.has(id)) {
      push('indeterminate', { pattern: patternDigest(d.query), reason: 'exclusion-not-in-profile' })
      continue
    }
    const declared = declaredExclusions.find((e) => e.id === id)
    push('excluded', {
      pattern: patternDigest(d.query),
      rule: { id, version: declared.version },
    })
  }

  for (const d of result.unattributed) {
    push('indeterminate', { pattern: patternDigest(d.query), reason: 'unattributed' })
  }

  for (const d of result.unreconciled) {
    push('observed-without-receipt', {
      pattern: patternDigest(d.query),
      objects: d.uncoveredTables || [],
    })
  }

  for (const d of result.indeterminate) {
    push('indeterminate', {
      pattern: patternDigest(d.query),
      reason: 'window-boundary',
      requiredSkewMs: d.requiredSkewMs,
    })
  }

  const max = profile?.maxStatementsPerReceipt ?? null
  for (const d of result.reconciled) {
    if (max == null) {
      push('indeterminate', {
        pattern: patternDigest(d.query),
        reason: 'multiplicity-undeclared',
        objects: d.tables || [],
      })
    } else if (d.delta <= max) {
      counts.matched += 1
    } else {
      push('observed-without-receipt', {
        pattern: patternDigest(d.query),
        objects: d.tables || [],
        reason: 'multiplicity-exceeded',
      })
    }
  }

  for (const u of result.unobserved) {
    push('receipted-without-observation', { objects: u.objects, ts: u.ts })
  }

  const exceptions =
    counts['observed-without-receipt'] > 0 ||
    counts['receipted-without-observation'] > 0 ||
    counts.indeterminate > 0

  return {
    v: RESULT_V2,
    window: result.window,
    source: result.source,
    snapshots: {
      start: sha256Of(ctx.snapshotStartRaw),
      end: sha256Of(ctx.snapshotEndRaw),
    },
    receipts: sha256Of(ctx.receiptsRaw),
    profile: profile
      ? { digest: sha256Of(ctx.profileRaw), version: profile.version }
      : null,
    bounds: {
      multiplicity: max != null ? 'operator-declared' : 'undeclared',
      skew: result.clocks.declaredSkewMs !== null ? 'operator-declared' : 'undeclared',
      exclusion: exclusionBoundDeclared ? 'operator-declared' : 'undeclared',
    },
    outcome: exceptions ? 'exceptions' : 'no-exceptions',
    items,
    counts,
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-reconcile --before <snapshot.json> --after <snapshot.json> --receipts <receipts.jsonl> [--skew <duration>] [--profile <path>] [--json] [--json-v2] [--result-v2 <path>]',
  )
  console.error(
    '  --skew  how far the gateway clock may differ from the database clock (e.g. 500ms, 5s, 2m).',
  )
  console.error(
    '          Receipts further outside the window than this are not skew. Without it, a pattern',
  )
  console.error(
    '          uncovered only by the boundary is reported as indeterminate rather than decided.',
  )
}

/**
 * `500ms`, `5s`, `2m`, `1h`, or a bare number of milliseconds. Declaring the
 * bound is the point, so an unparseable one is an error rather than a default:
 * a tolerance nobody chose is the kind of number this tool exists to refuse.
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] || 'ms'
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]
  return Math.round(n * scale)
}

function parseArgs(argv) {
  const out = {
    before: null,
    after: null,
    receiptsPath: null,
    profilePath: null,
    json: false,
    jsonV2: false,
    resultV2: null,
    skewMs: null,
  }
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
    } else if (a === '--profile') {
      out.profilePath = args.shift() ?? null
      if (!out.profilePath) throw new Error('--profile requires a path')
    } else if (a === '--skew') {
      const raw = args.shift() ?? null
      if (!raw) throw new Error('--skew requires a duration (e.g. 500ms, 5s, 2m)')
      const ms = parseDuration(raw)
      if (ms === null) throw new Error(`--skew: cannot read "${raw}" as a duration (try 500ms, 5s, 2m, 1h)`)
      out.skewMs = ms
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--json-v2') {
      out.jsonV2 = true
    } else if (a === '--result-v2') {
      out.resultV2 = args.shift() ?? null
      if (!out.resultV2) throw new Error('--result-v2 requires a path')
    } else if (a === '--help' || a === '-h') {
      usage()
      process.exit(0)
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  if (out.json && out.jsonV2) {
    throw new Error('--json and --json-v2 cannot share a body; a consumer MUST NOT read a /1 result as a /2 result')
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

  let profile = null
  let profileRaw = Buffer.from('')
  if (opts.profilePath) {
    const loaded = loadMappingProfile(opts.profilePath)
    if (loaded.error) fail(20, loaded.error, opts.json)
    profile = loaded.profile
    profileRaw = loaded.raw
  }

  const resolved = resolveDeclaredSkew(opts.skewMs, profile?.clocks?.skewMs ?? null)
  if (resolved.error) fail(20, resolved.error, opts.json)

  const result = reconcile(b.snapshot, a.snapshot, rec.receipts, { skewMs: resolved.skewMs })
  if (result.error) fail(20, result.error, opts.json)

  const wantV2 = opts.jsonV2 || opts.resultV2
  const v2 = wantV2
    ? projectResultV2(result, {
        profile,
        profileRaw,
        snapshotStartRaw: readFileSync(opts.before),
        snapshotEndRaw: readFileSync(opts.after),
        receiptsRaw: readFileSync(opts.receiptsPath),
      })
    : null
  if (opts.resultV2) writeFileSync(opts.resultV2, JSON.stringify(v2) + '\n')

  const problems = result.unreconciled.length + result.unattributed.length
  const undecided = result.indeterminate.length
  const exitCode = problems > 0 ? 40 : undecided > 0 ? 41 : 0

  if (opts.jsonV2) {
    console.log(JSON.stringify(v2))
  } else if (opts.json) {
    console.log(JSON.stringify({ ok: exitCode === 0, code: exitCode, ...result }))
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
      console.log(`  = (+${d.delta}) attributable to receipt(s) for [${d.tables.join(', ')}]: ${truncate(d.query)}`)
    }
    if (result.receipts.unassigned > 0) {
      console.warn(
        `warning: ${result.receipts.unassigned} receipt(s) in the window could not be attributed to a table — ` +
          `any "not receipted" finding below is NOT definitive`,
      )
    }
    if (result.unobserved.length > 0) {
      console.log(
        `UNOBSERVED: ${result.unobserved.length} receipt(s) named an object the database counters did not increment:`,
      )
      for (const u of result.unobserved) {
        console.log(`  · [${u.objects.join(', ')}] ${u.tool || 'receipt'} @ ${u.ts}`)
      }
    }
    if (result.indeterminate.length > 0) {
      const atBoundary = result.indeterminate.filter((d) => d.boundaryPlausible)
      const beyond = result.indeterminate.filter((d) => !d.boundaryPlausible)
      const line = (d) =>
        `  ~ (+${d.delta}) table(s) [${d.uncoveredTables.join(', ')}] have a receipt ${d.requiredSkewMs}ms outside ` +
        `the window: ${truncate(d.query)}`

      if (atBoundary.length > 0) {
        const bound =
          result.clocks.declaredSkewMs === null
            ? 'no skew bound was declared (--skew or Mapping Profile clocks.skew), so the window\'s own length is the only reference'
            : `declared skew bound is ${result.clocks.declaredSkewMs}ms`
        console.error(
          `INDETERMINATE: ${atBoundary.length} pattern(s) are uncovered only by the window boundary — ${bound}:`,
        )
        for (const d of atBoundary) console.error(line(d))
        console.error(
          `the window comes from ${result.clocks.window} and receipt timestamps come from the ${result.clocks.receipts} — ` +
            'two clocks. A receipt this close outside is either a trailing clock or a late receipt, and this tool ' +
            'cannot tell them apart. It is NOT reported as unreceipted access.',
        )
      }
      // Never exculpated. The class stays indeterminate because this tool still
      // cannot prove what happened, but a receipt further out than the window is
      // long is not a boundary artefact, and saying otherwise would shield the
      // exact case an attacker would arrange.
      if (beyond.length > 0) {
        console.error(
          `INDETERMINATE (not the boundary): ${beyond.length} pattern(s) have their only covering receipt further ` +
            `outside the window than the window is long (${result.clocks.windowMs}ms):`,
        )
        for (const d of beyond) console.error(line(d))
        console.error(
          'a boundary artefact cannot explain an offset larger than the window itself, so clock skew is not the ' +
            'reading here. This is NOT excused as a timing effect; it is left undecided because the receipt exists ' +
            'and this tool cannot say which access it belongs to. Declare --skew to make the question decidable.',
        )
      }
    }
    if (problems === 0 && undecided === 0) {
      console.log('ok: every DB query pattern in the window is attributable to receipt(s) for the same table')
      console.log(
        'scope: this is object attribution within the window, not per-statement coverage — ' +
          'one receipt naming a table clears further statements against that table. See LIMITATIONS.md.',
      )
    }
    // Guarded on `problems`, not on "not clean": a run whose only finding is
    // indeterminate must never print the bypass sentence. Reaching that
    // sentence through a clock difference is the defect this class exists for.
    if (problems > 0) {
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
  if (problems > 0) {
    process.exit(40)
  }
  if (undecided > 0) {
    process.exit(41)
  }
  process.exit(0)
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
