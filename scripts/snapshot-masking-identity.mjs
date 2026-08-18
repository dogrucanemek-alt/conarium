#!/usr/bin/env node
/** Hash of redact output for the bench-shaped unique-email payload. */
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const govJs = join(root, 'dist', 'governance.js')
if (!existsSync(govJs)) process.exit(2)
const { Governance } = await import(pathToFileURL(govJs).href)

const SECRET_EMAIL = 'bench-secret-user@example.com'
const QUERY = 'SELECT id, name, email, note FROM public.bench_customers ORDER BY id'
const label = process.argv[2] || 'before'
const sizes = (process.argv[3] || '100,500,5000').split(',').map(Number)

function rows(n) {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1
    return {
      id,
      name: `user-${id}`,
      email: id === 1 ? SECRET_EMAIL : `user-${id}@example.com`,
      note: `note ${id}`,
    }
  })
}

const out = { label, node: process.version, sizes: {} }
for (const n of sizes) {
  const gov = new Governance({
    allowTables: ['public.bench_customers'],
    maskColumns: ['*.email'],
    maxRows: Math.max(n, 100),
  })
  const guarded = gov.guardQuery(QUERY)
  const result = gov.redact(
    { rows: rows(n), rowCount: n, fields: ['id', 'name', 'email', 'note'], sql: guarded.sql },
    guarded.aliases,
    guarded.metadata,
  )
  const body = JSON.stringify({
    rows: result.rows,
    maskedCount: result.governance.maskedCount,
    byClass: result.governance.byClass ?? {},
    maskedFields: result.governance.maskedFields,
  })
  out.sizes[String(n)] = {
    sha256: createHash('sha256').update(body).digest('hex'),
    maskedCount: result.governance.maskedCount,
    byClass: result.governance.byClass ?? {},
    maskedFields: result.governance.maskedFields,
    sampleRow: result.rows[0],
    lastRow: result.rows[n - 1],
  }
}

const path = join(root, 'docs', 'benchmarks', `masking-identity-${label}.json`)
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
console.log(`wrote ${path}`)
