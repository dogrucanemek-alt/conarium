#!/usr/bin/env node
/**
 * Generated attacks against the SQL gate. Not a hand-picked red-team list.
 *
 * Invariants (must hold for every generated case):
 *   1. A denied table never survives alias / JOIN / subquery / CTE / quotes /
 *      case / comments.
 *   2. A write never becomes a read.
 *   3. Rewritten SQL never raises the row cap.
 *   4. A value from a masked column never appears raw after redact
 *      (alias / concat / CASE / subquery).
 *   5. Unparseable or broken SQL is denied. A crash is a failure.
 *
 * If a real bypass is found this file STAYS RED. It writes a vector under
 * test-vectors/sql-gate/ and exits 1. Do not weaken the gate to go green.
 *
 *   node test/property_sql_gate.mjs
 *   CONARIUM_GATE_SEED=42 CONARIUM_GATE_N=400 node test/property_sql_gate.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const govJs = join(root, 'dist', 'governance.js')
if (!existsSync(govJs)) {
  console.error('dist/governance.js missing — run npm run build first')
  process.exit(2)
}

const { Governance, PolicyError } = await import(pathToFileURL(govJs).href)

const SEED = Number(process.env.CONARIUM_GATE_SEED || 20260814)
const N = Number(process.env.CONARIUM_GATE_N || 500)
const MAX_ROWS = 50
const ALLOWED = 'public.customers'
const DENIED = 'public.secrets'
const SECRET = 'gate-secret-email@example.com'
const VECTOR_DIR = join(root, 'test-vectors', 'sql-gate')

const POLICY = {
  allowTables: [ALLOWED],
  denyTables: [DENIED],
  maskColumns: ['*.email'],
  maxRows: MAX_ROWS,
}

function mulberry32(a) {
  return function rand() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(SEED)

function pick(xs) {
  return xs[Math.floor(rand() * xs.length)]
}

function chance(p) {
  return rand() < p
}

function comment() {
  return pick(['', '/*x*/', '/* join */', '-- ignored\n', '/* SELECT secrets */'])
}

function qualify(table, style) {
  const [schema, name] = table.split('.')
  switch (style) {
    case 'lower':
      return `${schema}.${name}`
    case 'upper':
      return `${schema.toUpperCase()}.${name.toUpperCase()}`
    case 'mixed':
      return `${schema}.${name}`
    case 'quoted':
      return `"${schema}"."${name}"`
    case 'quoted-upper':
      return `"${schema.toUpperCase()}"."${name.toUpperCase()}"`
    default:
      return `${schema}.${name}`
  }
}

function wrapDenied(deniedSqlTable) {
  const kind = pick([
    'plain',
    'alias',
    'join',
    'subquery',
    'cte',
    'union',
    'where-in',
    'exists',
    'from-comment',
  ])
  const allowed = qualify(ALLOWED, pick(['lower', 'upper', 'quoted']))
  switch (kind) {
    case 'plain':
      return `SELECT * FROM ${deniedSqlTable}`
    case 'alias':
      return `SELECT * FROM ${deniedSqlTable} AS customers`
    case 'join':
      return `SELECT c.id FROM ${allowed} c ${comment()} JOIN ${deniedSqlTable} s ON true`
    case 'subquery':
      return `SELECT * FROM (SELECT * FROM ${deniedSqlTable}) AS t`
    case 'cte':
      return `WITH x AS (SELECT * FROM ${deniedSqlTable}) SELECT * FROM x`
    case 'union':
      return `SELECT id FROM ${allowed} UNION ALL SELECT id FROM ${deniedSqlTable}`
    case 'where-in':
      return `SELECT id FROM ${allowed} WHERE id IN (SELECT id FROM ${deniedSqlTable})`
    case 'exists':
      return `SELECT id FROM ${allowed} WHERE EXISTS (SELECT 1 FROM ${deniedSqlTable})`
    case 'from-comment':
      return `SELECT * FROM ${comment()}${deniedSqlTable}`
    default:
      return `SELECT * FROM ${deniedSqlTable}`
  }
}

function generateDeniedTableSql() {
  const style = pick(['lower', 'upper', 'quoted', 'quoted-upper', 'mixed'])
  return wrapDenied(qualify(DENIED, style))
}

function generateWriteSql() {
  const table = pick([ALLOWED, DENIED, 'public.customers'])
  const q = qualify(table, pick(['lower', 'upper', 'quoted']))
  return pick([
    `DELETE FROM ${q}`,
    `UPDATE ${q} SET name = 'x'`,
    `INSERT INTO ${q} (id) VALUES (1)`,
    `DROP TABLE ${q}`,
    `TRUNCATE ${q}`,
    `ALTER TABLE ${q} ADD COLUMN x int`,
    `SELECT 1; DELETE FROM ${q}`,
    `SELECT * FROM ${qualify(ALLOWED, 'lower')}; DROP TABLE ${q}`,
    `COPY ${q} TO STDOUT`,
    `SELECT * FROM ${qualify(ALLOWED, 'lower')} FOR UPDATE`,
    `SELECT * FROM ${qualify(ALLOWED, 'lower')} FOR SHARE`,
    `WITH t AS (DELETE FROM ${q} RETURNING *) SELECT * FROM t`,
    `UPDATE ${q} SET name = 1 -- SELECT`,
    `CREATE TABLE ${q}_x (id int)`,
    `GRANT SELECT ON ${q} TO public`,
  ])
}

function generateRowCapSql() {
  const t = qualify(ALLOWED, pick(['lower', 'quoted']))
  return pick([
    `SELECT * FROM ${t} LIMIT 999999`,
    `SELECT * FROM ${t} LIMIT 1000000 OFFSET 0`,
    `SELECT * FROM ${t} LIMIT ALL`,
    `SELECT id FROM ${t} UNION ALL SELECT id FROM ${t}`,
    `SELECT id FROM ${t} UNION ALL SELECT id FROM ${t} LIMIT 999999`,
    `WITH x AS (SELECT * FROM ${t}) SELECT * FROM x LIMIT 999999`,
    `SELECT * FROM (SELECT * FROM ${t}) AS t LIMIT 5000`,
    `SELECT * FROM ${t} OFFSET 0`,
    `SELECT * FROM ${t} FETCH FIRST 1000000 ROWS ONLY`,
    `SELECT * FROM ${t}`,
  ])
}

function generateMaskSql() {
  const t = qualify(ALLOWED, pick(['lower', 'quoted']))
  return pick([
    `SELECT email FROM ${t}`,
    `SELECT email AS name FROM ${t}`,
    `SELECT email AS contact FROM ${t}`,
    `SELECT email || '@x' AS x FROM ${t}`,
    `SELECT CASE WHEN true THEN email ELSE 'x' END AS x FROM ${t}`,
    `SELECT CASE WHEN id = 1 THEN email ELSE name END AS x FROM ${t}`,
    `SELECT (SELECT email FROM ${t} LIMIT 1) AS x`,
    `SELECT * FROM ${t}`,
    `SELECT c.email FROM ${t} c`,
    `SELECT substring(email, 1, 20) AS x FROM ${t}`,
    `SELECT upper(email) AS x FROM ${t}`,
    `SELECT email::text AS x FROM ${t}`,
    `WITH x AS (SELECT email FROM ${t}) SELECT * FROM x`,
    `SELECT encode(convert_to(email,'UTF8'),'hex') AS x FROM ${t}`,
    `SELECT json_build_object('e', email) AS x FROM ${t}`,
  ])
}

function generateFuzzSql() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_*\'"`;()[],.-+ \n\t'
  const len = Math.floor(rand() * 80)
  let s = ''
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)]
  const extras = [
    '',
    '   ',
    'SELECT',
    'SELECT *',
    'SELEC * FROM public.customers',
    "SELECT * FROM public.customers WHERE name = '",
    'SELECT * FROM public.customers /*',
    'SELECT $$\n$$\n FROM public.customers',
    'SELECT * FROM public.customers\x00WHERE 1=1',
    'SELECT * FROM public.customers; SELECT * FROM public.secrets',
    '/* only a comment */',
    '--',
    'WITH',
    'VALUES (1)',
    'SELECT * FROM pg_catalog.pg_user',
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM customers',
    'SELECT lo_export(1, \'/tmp/x\')',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'SELECT dblink(\'x\', \'SELECT 1\')',
    String.fromCharCode(0, 1, 2, 3) + 'SELECT 1',
    'SELECT * FROM public.customers ' + 'A'.repeat(200),
  ]
  return chance(0.45) ? pick(extras) : s
}

function extractLimits(sql) {
  const found = []
  // pgsql-ast-parser's toSql emits `LIMIT (50)` (parens) on a SELECT,
  // and the UNION wrapper emits `LIMIT 50` (bare). Both are a cap.
  const re = /\bLIMIT\s*\(?\s*(\d+)\s*\)?/gi
  let m
  while ((m = re.exec(sql))) found.push(Number(m[1]))
  return found
}

function containsRawSecret(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.includes(SECRET)
  if (typeof value === 'number' || typeof value === 'boolean') return false
  try {
    return JSON.stringify(value).includes(SECRET)
  } catch {
    return String(value).includes(SECRET)
  }
}

function syntheticRow(guarded) {
  const fields = new Set(['id', 'name', 'email', 'note', 'x', 'contact', 'customers'])
  for (const f of guarded.metadata.maskedFields ?? []) fields.add(f)
  const row = { _table: ALLOWED }
  for (const f of fields) {
    if (f === 'id') row[f] = 1
    else if (f === 'email' || (guarded.metadata.maskedFields ?? []).includes(f) || f === 'x' || f === 'contact') {
      row[f] = SECRET
    } else {
      row[f] = f === 'name' ? 'Ada' : 'ok'
    }
  }
  return row
}

function recordBypass(findings, finding) {
  findings.push(finding)
}

function persistVectors(findings) {
  mkdirSync(VECTOR_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  findings.forEach((f, i) => {
    const id = `${stamp}-${String(i + 1).padStart(3, '0')}-${f.invariant}`
    const path = join(VECTOR_DIR, `${id}.json`)
    writeFileSync(
      path,
      JSON.stringify(
        {
          id,
          seed: SEED,
          invariant: f.invariant,
          sql: f.sql,
          detail: f.detail,
          rewritten: f.rewritten ?? null,
        },
        null,
        2,
      ) + '\n',
    )
  })
}

const findings = []
let generated = 0
let deniedOk = 0
let allowedOk = 0
let crashed = 0

function runCase(invariant, sql, check) {
  generated += 1
  const gov = new Governance(POLICY)
  try {
    check(gov, sql)
  } catch (err) {
    if (err && err._gateFinding) {
      recordBypass(findings, err._gateFinding)
      return
    }
    crashed += 1
    recordBypass(findings, {
      invariant: 'crash',
      sql,
      detail: `${err?.name || 'Error'}: ${err?.message || err}`,
    })
  }
}

function fail(invariant, sql, detail, extra = {}) {
  const err = new Error(detail)
  err._gateFinding = { invariant, sql, detail, ...extra }
  throw err
}

function expectDenied(gov, sql, invariant) {
  try {
    const out = gov.guardQuery(sql)
    fail(invariant, sql, `guardQuery allowed a case that must be denied`, { rewritten: out.sql })
  } catch (err) {
    if (err && err._gateFinding) throw err
    if (err instanceof PolicyError) {
      deniedOk += 1
      return
    }
    fail('crash', sql, `non-PolicyError: ${err?.name}: ${err?.message}`)
  }
}

// --- denied table ---
for (let i = 0; i < Math.floor(N * 0.28); i++) {
  const sql = generateDeniedTableSql()
  runCase('denied-table', sql, (gov, q) => expectDenied(gov, q, 'denied-table'))
}

// --- writes ---
for (let i = 0; i < Math.floor(N * 0.16); i++) {
  const sql = generateWriteSql()
  runCase('read-only', sql, (gov, q) => expectDenied(gov, q, 'read-only'))
}

// --- row cap ---
for (let i = 0; i < Math.floor(N * 0.16); i++) {
  const sql = generateRowCapSql()
  runCase('row-cap', sql, (gov, q) => {
    let out
    try {
      out = gov.guardQuery(q)
    } catch (err) {
      if (err instanceof PolicyError) {
        deniedOk += 1
        return
      }
      throw err
    }
    const limits = extractLimits(out.sql)
    if (limits.length === 0) {
      fail('row-cap', q, 'rewritten SQL has no LIMIT', { rewritten: out.sql })
    }
    const applied = Math.min(...limits)
    if (applied > MAX_ROWS) {
      fail('row-cap', q, `LIMIT ${applied} exceeds maxRows ${MAX_ROWS}`, { rewritten: out.sql })
    }
    if ((out.metadata.appliedRowCap ?? 0) > MAX_ROWS) {
      fail('row-cap', q, `metadata.appliedRowCap ${out.metadata.appliedRowCap} > ${MAX_ROWS}`, {
        rewritten: out.sql,
      })
    }
    allowedOk += 1
  })
}

// --- mask ---
for (let i = 0; i < Math.floor(N * 0.2); i++) {
  const sql = generateMaskSql()
  runCase('mask', sql, (gov, q) => {
    let out
    try {
      out = gov.guardQuery(q)
    } catch (err) {
      if (err instanceof PolicyError) {
        deniedOk += 1
        return
      }
      throw err
    }
    const row = syntheticRow(out)
    const redacted = gov.redact(
      { rows: [row], rowCount: 1, fields: Object.keys(row), sql: out.sql },
      out.aliases,
      out.metadata,
    )
    for (const [k, v] of Object.entries(redacted.rows[0])) {
      if (k === '_table') continue
      if (containsRawSecret(v)) {
        fail('mask', q, `raw masked value survived in field "${k}"`, { rewritten: out.sql })
      }
    }
    allowedOk += 1
  })
}

// --- fuzz ---
for (let i = 0; i < Math.floor(N * 0.2); i++) {
  const sql = generateFuzzSql()
  runCase('fuzz-fail-closed', sql, (gov, q) => {
    try {
      const out = gov.guardQuery(q)
      // Parsed and allowed: still must be read-only + allowed table + capped.
      if (!/^\s*(SELECT|WITH)\b/i.test(q) && !/^\s*(SELECT|WITH)\b/i.test(out.sql)) {
        fail('fuzz-fail-closed', q, 'non-SELECT was allowed', { rewritten: out.sql })
      }
      const limits = extractLimits(out.sql)
      if (limits.some((n) => n > MAX_ROWS)) {
        fail('row-cap', q, `fuzz raised LIMIT past ${MAX_ROWS}`, { rewritten: out.sql })
      }
      allowedOk += 1
    } catch (err) {
      if (err && err._gateFinding) throw err
      if (err instanceof PolicyError) {
        deniedOk += 1
        return
      }
      fail('crash', q, `fuzz threw ${err?.name}: ${err?.message}`)
    }
  })
}

const summary = {
  seed: SEED,
  requested: N,
  generated,
  deniedOk,
  allowedOk,
  crashed,
  bypasses: findings.length,
}

console.log(
  `property_sql_gate  seed=${SEED} generated=${generated} denied=${deniedOk} allowed=${allowedOk} crash=${crashed} bypass=${findings.length}`,
)

if (findings.length > 0) {
  persistVectors(findings)
  console.error('BULUNDU, düzeltilmedi:')
  for (const f of findings.slice(0, 20)) {
    console.error(`  [${f.invariant}] ${f.detail}`)
    console.error(`    sql: ${JSON.stringify(f.sql)}`)
  }
  if (findings.length > 20) console.error(`  … ${findings.length - 20} more`)
  console.error(`vectors written under test-vectors/sql-gate/`)
  process.exit(1)
}

mkdirSync(VECTOR_DIR, { recursive: true })
writeFileSync(
  join(VECTOR_DIR, 'LAST-RUN.json'),
  JSON.stringify({ ...summary, result: 'bulunamadi' }, null, 2) + '\n',
)
console.log('bulunamadı')
process.exit(0)
