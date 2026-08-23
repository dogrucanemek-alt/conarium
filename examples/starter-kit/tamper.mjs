#!/usr/bin/env node
/** Flip one byte in the last receipt and show conarium-verify turning red. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CORE = join(here, 'node_modules', '@conarium-ai', 'core')
const VERIFY = join(CORE, 'bin', 'conarium-verify.mjs')
const RECEIPTS = join(here, 'conarium-receipts.jsonl')
const PUB = join(here, '_keys', 'audit-ed25519.pub.pem')

if (!existsSync(RECEIPTS) || !existsSync(PUB)) {
  console.error('FAIL  run npm start first (needs receipts and a public key)')
  process.exit(1)
}

const lines = readFileSync(RECEIPTS, 'utf8').trim().split('\n').filter(Boolean)
if (lines.length === 0) {
  console.error('FAIL  receipt file is empty — run npm start first')
  process.exit(1)
}
const last = lines[lines.length - 1]
const flipped = last.includes('a') ? last.replace('a', 'b') : `${last.slice(0, -1)}X`
lines[lines.length - 1] = flipped
const broken = join(here, 'conarium-receipts.tampered.jsonl')
writeFileSync(broken, `${lines.join('\n')}\n`)

const r = spawnSync(process.execPath, [VERIFY, broken, '--pubkey', PUB], {
  cwd: here,
  encoding: 'utf8',
})
const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
console.log(`conarium-verify exit ${r.status}`)
if (out) console.log(out.slice(0, 600))
if (r.status === 0) {
  console.error('FAIL  tampered receipts still verified')
  process.exit(1)
}
console.log('PASS  tamper is red (verify exit != 0)')
