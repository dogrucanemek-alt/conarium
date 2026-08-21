/**
 * Usage errors must not return a verdict code.
 *
 * `conarium-verify` used to exit 20 for an unknown flag and for a missing
 * path — the same code the tables name "Schema invalid". No receipt is read
 * on those paths, so no verdict has been reached.
 *
 * KIRMA: change the usage `process.exit` calls in bin/conarium-verify.mjs
 * back to 20. Then "unknown flag is not 20" goes red. That assert is the
 * whole point of this file.
 *
 * Measure the exit status of the node process itself. Do not pipe.
 */
import assert from 'assert/strict'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const VERIFY = path.join(root, 'bin', 'conarium-verify.mjs')
const VECTOR = path.join(root, 'test-vectors', '001-single-receipt', 'receipts.jsonl')
const SCHEMA = path.join(root, 'test-vectors', '007-schema-invalid', 'receipts.jsonl')
const PUB = path.join(root, 'test-vectors', 'keys', 'vector-key.pub.pem')

function run(args) {
  const r = spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('unknown flag is not 20', () => {
  const r = run([VECTOR, '--file', 'x'])
  assert.notEqual(
    r.status,
    20,
    `unknown flag returned 20 — a verdict code for a receipt that was never read\n${r.stderr}`,
  )
  assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}\n${r.stderr}`)
})

test('missing path is not 20', () => {
  const r = run([])
  assert.notEqual(r.status, 20, `missing path returned 20\n${r.stderr}`)
  assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}\n${r.stderr}`)
})

test('schema-invalid vector is still 20', () => {
  const r = run([SCHEMA, '--pubkey', PUB])
  assert.equal(r.status, 20, `007 must stay 20, got ${r.status}\n${r.stderr}`)
})

for (const { name, fn } of tests) {
  try {
    fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}`)
    console.log(err.message)
  }
}

if (failCount) {
  console.log(`\n${failCount} failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\n${passCount} passed`)
