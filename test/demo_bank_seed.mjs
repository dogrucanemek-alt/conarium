/**
 * Static honesty checks for examples/demo-bank.
 * Does not start Docker. A valid TCKN checksum in the seed is a fail —
 * Claude will plant one on purpose.
 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', 'examples', 'demo-bank')

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function tcknChecksumOk(s) {
  if (!/^[1-9][0-9]{10}$/.test(s)) return false
  const d = [...s].map(Number)
  const odd = d[0] + d[2] + d[4] + d[6] + d[8]
  const even = d[1] + d[3] + d[5] + d[7]
  const d10 = (((odd * 7 - even) % 10) + 10) % 10
  if (d[9] !== d10) return false
  const d11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10
  return d[10] === d11
}

test('seed TCKN-like numbers fail the checksum', () => {
  const seed = fs.readFileSync(path.join(root, 'seed.sql'), 'utf8')
  const hits = seed.match(/[1-9][0-9]{10}/g) || []
  for (const n of hits) {
    assert.ok(!tcknChecksumOk(n), `seed contains a checksum-valid TCKN: ${n}`)
  }
})

test('seed IBANs are the zero demo pattern, not a real bank', () => {
  const seed = fs.readFileSync(path.join(root, 'seed.sql'), 'utf8')
  assert.ok(/TR00/.test(seed), 'expected TR00 demo IBANs')
  assert.ok(!/TR[0-9]{2}[1-9]/.test(seed.replace(/TR00/g, '')), 'non-zero TR IBAN prefix in seed')
})

test('config denies card_vault and masks tckn/iban', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'conarium.config.json'), 'utf8'))
  assert.ok(cfg.policy.denyTables.includes('public.card_vault'))
  assert.ok(cfg.policy.maskColumns.includes('*.tckn'))
  assert.ok(cfg.policy.maskColumns.includes('*.iban'))
  assert.ok(cfg.policy.allowTables.includes('public.accounts'))
  const url = cfg.connectors[0].config.url
  assert.ok(url.includes('127.0.0.1'))
  assert.ok(url.includes('54329'))
  assert.ok(!/supabase\.co|amazonaws|azure|neon\.tech/.test(url), 'DSN looks like a hosted database')
})

test('prove-receipt goes through the gateway, not Governance directly', () => {
  const src = fs.readFileSync(path.join(root, 'prove-receipt.mjs'), 'utf8')
  assert.ok(!/governance\.js/.test(src), 'must not import Governance — that was the hole')
  assert.ok(/dist\/index\.js/.test(src), 'must spawn the MCP gateway')
  assert.ok(/StdioClientTransport/.test(src), 'must speak MCP over stdio')
  assert.ok(/conarium-verify/.test(src), 'must run the independent verifier')
})

test('README does not claim a shared credential names a person', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  assert.ok(/undeclared/.test(readme))
  assert.ok(/shared/.test(readme))
  assert.ok(!/Makbuz kimin eriştiğini söyler|receipt (says|tells).+who accessed/i.test(readme))
})

for (const { name, fn } of tests) {
  try {
    fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}\n        ${err.message}`)
  }
}
console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
process.exitCode = failCount > 0 ? 1 : 0
