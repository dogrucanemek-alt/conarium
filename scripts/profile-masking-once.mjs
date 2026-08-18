#!/usr/bin/env node
/** Isolated one-shot: kind=allow|partial|carry  [n] */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const govJs = join(root, 'dist', 'governance.js')
if (!existsSync(govJs)) {
  console.error('dist/governance.js missing')
  process.exit(2)
}
const { Governance } = await import(pathToFileURL(govJs).href)

const kind = process.argv[2] || 'partial'
const n = Number(process.argv[3] || 5_000)
const SECRET_EMAIL = 'bench-secret-user@example.com'
const QUERY = 'SELECT id, name, email, note FROM public.bench_customers ORDER BY id'

const rows = new Array(n)
for (let i = 1; i <= n; i++) {
  rows[i - 1] = {
    id: i,
    name: `user-${i}`,
    email: i === 1 ? SECRET_EMAIL : `user-${i}@example.com`,
    note: `note ${i}`,
  }
}

if (kind === 'carry') {
  const declared = rows.map((r) => r.email)
  const unique = new Set()
  for (const value of declared) {
    const trimmed = value.trim()
    if (trimmed.length >= 3) unique.add(trimmed)
  }
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const t0 = performance.now()
  const matchers = [...unique]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'giu'))
  const compileMs = performance.now() - t0
  const t1 = performance.now()
  let hits = 0
  for (const row of rows) {
    for (const text of [row.name, row.note]) {
      let out = text
      for (const matcher of matchers) {
        out = out.replace(matcher, () => {
          hits++
          return '[MASKED_PII]'
        })
      }
    }
  }
  const applyMs = performance.now() - t1
  console.log(JSON.stringify({ kind, n, compileMs, applyMs, hits, matchers: matchers.length }))
  process.exit(0)
}

const policy =
  kind === 'allow'
    ? { allowTables: ['public.bench_customers'], maxRows: Math.max(n, 100) }
    : { allowTables: ['public.bench_customers'], maskColumns: ['*.email'], maxRows: Math.max(n, 100) }
const gov = new Governance(policy)
const guarded = gov.guardQuery(QUERY)
const payload = { rows, rowCount: n, fields: ['id', 'name', 'email', 'note'], sql: guarded.sql }
const t0 = performance.now()
const out = gov.redact(payload, guarded.aliases, guarded.metadata)
const ms = performance.now() - t0
console.log(JSON.stringify({
  kind,
  n,
  ms,
  maskedCount: out.governance.maskedCount,
  byClass: out.governance.byClass ?? {},
  maskedFields: out.governance.maskedFields,
}))
