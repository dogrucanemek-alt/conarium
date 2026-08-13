#!/usr/bin/env node
/**
 * Mint a per-user token into conarium.tokens.json.
 *
 * The file stores SHA-256 only. The raw token is printed once, to stdout,
 * and is never written. 0600 on POSIX.
 *
 *   node mint-token.mjs --id emekcan [--file ./conarium.tokens.json]
 *
 * Exit: 0 wrote · 1 refused · 2 could not run
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { platform } from 'node:os'

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const valueOf = (f, fallback) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback
}

if (has('--help') || has('-h')) {
  console.log(`conarium mint-token — append a hashed per-user token

  --id <actor>     person id written on the receipt (required)
  --file <path>    tokens file (default: ./conarium.tokens.json)
  --bytes <n>      raw token length (default: 32)

The raw token is printed once. It is not stored.`)
  process.exit(0)
}

const id = valueOf('--id', '')
if (!id || id.startsWith('--')) {
  console.error('refusing: --id <actor> is required')
  process.exit(1)
}

const file = resolve(process.cwd(), valueOf('--file', './conarium.tokens.json'))
const bytes = Number(valueOf('--bytes', '32'))
if (!Number.isInteger(bytes) || bytes < 24 || bytes > 64) {
  console.error('refusing: --bytes must be an integer 24–64')
  process.exit(1)
}

const raw = randomBytes(bytes).toString('base64url')
const sha256 = createHash('sha256').update(raw).digest('hex')

let doc = { tokens: [] }
if (existsSync(file)) {
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`)
    process.exit(2)
  }
  if (!Array.isArray(doc.tokens)) doc.tokens = []
}

if (doc.tokens.some((t) => t && t.sha256 === sha256)) {
  console.error('refusing: hash collision (rerun)')
  process.exit(1)
}

doc.tokens.push({ sha256, id })

try {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8' })
  if (platform() !== 'win32') {
    try { chmodSync(file, 0o600) } catch { /* doctor still accepts */ }
  }
} catch (e) {
  console.error(`cannot write ${file}: ${e.message}`)
  process.exit(2)
}

const stored = readFileSync(file, 'utf8')
if (stored.includes(raw)) {
  console.error('refusing: raw token leaked into the file — not printing it')
  process.exit(2)
}

console.log(`id        ${id}`)
console.log(`sha256    ${sha256}`)
console.log(`file      ${file}`)
console.log(`token     ${raw}`)
console.log('')
console.log('The token line is the only copy. Put it in the client env, not in git.')
process.exit(0)
