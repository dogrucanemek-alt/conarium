#!/usr/bin/env node
/**
 * One-shot profiler for the 5 000-row masked redact path.
 * Does not publish numbers into docs/BENCHMARK.md.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const govJs = join(root, 'dist', 'governance.js')
if (!existsSync(govJs)) {
  console.error('dist/governance.js missing — run npm run build first')
  process.exit(2)
}

const { Governance } = await import(pathToFileURL(govJs).href)
const n = Number(process.argv[2] || 5_000)
const SECRET_EMAIL = 'bench-secret-user@example.com'
const QUERY = 'SELECT id, name, email, note FROM public.bench_customers ORDER BY id'

function syntheticRows(count) {
  const rows = new Array(count)
  for (let i = 1; i <= count; i++) {
    rows[i - 1] = {
      id: i,
      name: `user-${i}`,
      email: i === 1 ? SECRET_EMAIL : `user-${i}@example.com`,
      note: `note ${i}`,
    }
  }
  return rows
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function knownValueMatchers(values) {
  const unique = new Set()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length >= 3) unique.add(trimmed)
  }
  return [...unique]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'giu'))
}

function redactKnownValues(text, matchers) {
  let out = text
  let count = 0
  for (const matcher of matchers) {
    out = out.replace(matcher, () => {
      count++
      return '[MASKED_PII]'
    })
  }
  return { text: out, count }
}

const rows = syntheticRows(n)
const declared = rows.map((r) => r.email)

const tCompile0 = performance.now()
const matchers = knownValueMatchers(declared)
const compileMs = performance.now() - tCompile0

const nameSample = rows[0].name
const noteSample = rows[0].note
const tOneField0 = performance.now()
redactKnownValues(nameSample, matchers)
redactKnownValues(noteSample, matchers)
const oneRowCarryMs = performance.now() - tOneField0

const tAllCarry0 = performance.now()
let carryHits = 0
for (const row of rows) {
  carryHits += redactKnownValues(row.name, matchers).count
  carryHits += redactKnownValues(row.note, matchers).count
}
const allCarryMs = performance.now() - tAllCarry0

const govPartial = new Governance({
  allowTables: ['public.bench_customers'],
  maskColumns: ['*.email'],
  maxRows: Math.max(n, 100),
})
const govAllow = new Governance({
  allowTables: ['public.bench_customers'],
  maxRows: Math.max(n, 100),
})
const guarded = govPartial.guardQuery(QUERY)
const payload = {
  rows,
  rowCount: n,
  fields: ['id', 'name', 'email', 'note'],
  sql: guarded.sql,
}

// warmup
govPartial.redact(payload, guarded.aliases, guarded.metadata)
govAllow.redact(payload, guarded.aliases, guarded.metadata)

const tPartial0 = performance.now()
const partial = govPartial.redact(payload, guarded.aliases, guarded.metadata)
const partialMs = performance.now() - tPartial0

const tAllow0 = performance.now()
const allow = govAllow.redact(payload, guarded.aliases, guarded.metadata)
const allowMs = performance.now() - tAllow0

const report = {
  n,
  node: process.version,
  compileMatchersMs: compileMs,
  matcherCount: matchers.length,
  oneRowTwoFieldsCarryMs: oneRowCarryMs,
  allRowsCarryOnlyMs: allCarryMs,
  carryHits,
  fullRedactPartialMs: partialMs,
  fullRedactAllowMs: allowMs,
  impliedCarryPerRowMs: allCarryMs / n,
  impliedIfLinearFrom100: (allCarryMs / n) * 100,
  quadraticSignature: {
    matchers: matchers.length,
    fieldsPerRow: 2,
    replaceCalls: matchers.length * n * 2,
  },
  maskedCountPartial: partial.governance.maskedCount,
  maskedCountAllow: allow.governance.maskedCount,
  byClassPartial: partial.governance.byClass ?? {},
  byClassAllow: allow.governance.byClass ?? {},
}

const outPath = join(root, 'docs', 'benchmarks', `masking-profile-${n}.json`)
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
console.log(`wrote ${outPath}`)
