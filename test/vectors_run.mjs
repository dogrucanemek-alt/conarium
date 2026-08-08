#!/usr/bin/env node
/**
 * Runs every frozen vector in test-vectors/ through bin/conarium-verify.mjs and
 * asserts the documented exit code.
 *
 * Why this exists: vectors nobody runs are documentation, and documentation
 * rots. Wiring them into the gate means a change that alters the hash, the
 * canonical form, or an exit code fails here first — which is the whole point
 * of publishing them.
 */
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = 'test-vectors'
const manifestPath = join(ROOT, 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`FAIL: ${manifestPath} not found — run node scripts/gen-test-vectors.mjs`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
let passed = 0
const failures = []

for (const c of manifest.cases) {
  const dir = join(ROOT, c.name)
  const args = [
    'bin/conarium-verify.mjs',
    join(dir, 'receipts.jsonl'),
    ...c.args.map((a) => a.replace('KEYS/', join(ROOT, 'keys') + '/')),
  ]

  let actual = 0
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' })
  } catch (err) {
    actual = typeof err.status === 'number' ? err.status : -1
  }

  if (actual === c.exitCode) {
    console.log(`PASS  ${c.name} -> ${actual}`)
    passed++
  } else {
    console.log(`FAIL  ${c.name} -> expected ${c.exitCode}, got ${actual}`)
    failures.push(`${c.name}: expected ${c.exitCode}, got ${actual}`)
  }
}

// The vectors must also stay byte-frozen. A hash recorded here that no longer
// matches the file means someone regenerated the vectors instead of fixing the
// code — the failure mode these vectors exist to prevent.
const FROZEN_FIRST_HASH = 'sha256:dbbbd3139923cdf7f854283b495386526de0629a71dc4d5407a3a810ee3e1847'
const first = JSON.parse(readFileSync(join(ROOT, '001-single-receipt', 'receipts.jsonl'), 'utf-8').trim())
if (first.chain.hash !== FROZEN_FIRST_HASH) {
  failures.push(`vector 001 hash drifted: expected ${FROZEN_FIRST_HASH}, file has ${first.chain.hash}`)
  console.log(`FAIL  frozen-hash -> ${first.chain.hash}`)
} else {
  console.log('PASS  frozen-hash')
  passed++
}

console.log(`\nSummary: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
