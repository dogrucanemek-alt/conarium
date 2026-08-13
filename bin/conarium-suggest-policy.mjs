#!/usr/bin/env node
/**
 * conarium-suggest-policy — column-name guess for maskColumns.
 *
 * Standalone: Node builtins only. Does not import src/ or dist/.
 * Does not write conarium.config.json. The operator copies what they accept.
 *
 * "This is a guess; it looks at column names, not data."
 *
 * Exit: 0 printed · 1 refused (missing file / cannot read) · 2 usage
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const HONESTY = 'This is a guess; it looks at column names, not data.'

const HINTS = [
  /adres/i,
  /address/i,
  /name/i,
  /ad_soyad/i,
  /soyad/i,
  /mahalle/i,
  /ilce/i,
  /passport/i,
  /pasaport/i,
  /(?:^|[._-])ip(?:$|[._-])/i,
  /tckn/i,
  /email/i,
  /iban/i,
  /phone/i,
  /telefon/i,
  /holder/i,
  /(?:^|[._-])pan(?:$|[._-])/i,
  /cvv/i,
  /tc_no/i,
  /tcno/i,
]

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const valueOf = (f) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : null
}

function usage(msg) {
  if (msg) console.error(msg)
  console.error(`conarium-suggest-policy — suggest maskColumns from column names

  --sql <file>   CREATE TABLE script (no database needed)
  --json         machine-readable output
  --help         this text

Does not write config. Does not look at row values.
Exit: 0 printed · 1 refused · 2 usage`)
}

if (has('--help') || has('-h')) {
  usage()
  process.exit(0)
}

if (has('--write') || has('--apply') || has('--out')) {
  console.error('conarium-suggest-policy does not write config. Copy the suggestion yourself.')
  process.exit(1)
}

const sqlPath = valueOf('--sql')
if (!sqlPath) {
  usage('missing --sql <file>')
  process.exit(2)
}

const abs = resolve(sqlPath)
if (!existsSync(abs)) {
  console.error(`no such file: ${abs}`)
  process.exit(1)
}
try {
  if (!statSync(abs).isFile()) {
    console.error(`not a file: ${abs}`)
    process.exit(1)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

let sql
try {
  sql = readFileSync(abs, 'utf8')
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

function columnsFromSql(text) {
  const cols = []
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi
  let m
  while ((m = re.exec(text))) {
    const table = m[2]
    const body = m[3]
    for (const part of body.split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) continue
      const col = trimmed.split(/\s+/)[0]?.replace(/"/g, '')
      if (col) cols.push({ table, column: col })
    }
  }
  return cols
}

function suggest(columns) {
  const seen = new Set()
  const maskColumns = []
  for (const { column } of columns) {
    if (!HINTS.some((re) => re.test(column))) continue
    const glob = `*.${column}`
    if (seen.has(glob)) continue
    seen.add(glob)
    maskColumns.push(glob)
  }
  return maskColumns
}

const maskColumns = suggest(columnsFromSql(sql))

if (has('--json')) {
  process.stdout.write(
    JSON.stringify({ honesty: HONESTY, maskColumns, wroteConfig: false }, null, 2) + '\n',
  )
} else {
  process.stdout.write(`${HONESTY}\n\nwroteConfig: false\n\nSuggested maskColumns:\n`)
  if (maskColumns.length === 0) {
    process.stdout.write('  (none)\n')
  } else {
    for (const c of maskColumns) process.stdout.write(`  ${c}\n`)
  }
}
process.exit(0)
