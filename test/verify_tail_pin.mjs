/**
 * Opt-in tail pins for conarium-verify (paket #12 / G2).
 *
 * Default `conarium-verify <file>` MUST still exit 0 on a chain that had its
 * last receipts deleted — a leftover prefix is a valid shorter chain.
 * `--expect-count` / `--expect-last-hash` are the pin; a miss is exit 11.
 *
 * KIRMA: delete the expectCount / expectLastHash checks in
 * bin/conarium-verify.mjs. Then (b) `status === 11` and (e) `status === 11`
 * go red — those two asserts are the whole point of the pin. (c) staying 0
 * is the compatibility lock; if (c) becomes 11, default behaviour changed.
 */
import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const VERIFY = path.join(root, 'bin', 'conarium-verify.mjs')
const VECTOR = path.join(root, 'test-vectors', '002-chain-of-three', 'receipts.jsonl')
const PUB = path.join(root, 'test-vectors', 'keys', 'vector-key.pub.pem')
const LAST =
  'sha256:a06a30c3fb4bdbd46bb9400da0815fb3a7007b703cc9cb41208be08413e254c7'
const WRONG =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000'

function verify(file, extra = []) {
  const r = spawnSync(process.execPath, [VERIFY, file, '--pubkey', PUB, ...extra], {
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conarium-g12-pin-'))
const full = fs.readFileSync(VECTOR, 'utf8').trim().split('\n').filter(Boolean)
assert.equal(full.length, 3, 'vector 002 must be three receipts')
const tailCut = path.join(tmp, 'tail-cut.jsonl')
fs.writeFileSync(tailCut, full.slice(0, 2).join('\n') + '\n')
const empty = path.join(tmp, 'empty.jsonl')
fs.writeFileSync(empty, '')

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('(a) --expect-count 3 on intact vector → 0', () => {
  const r = verify(VECTOR, ['--expect-count', '3'])
  assert.equal(r.status, 0, r.stderr)
})

test('(b) KIRMA: tail deleted + --expect-count 3 → 11', () => {
  const r = verify(tailCut, ['--expect-count', '3'])
  assert.equal(r.status, 11, `expected 11, got ${r.status}\n${r.stderr}`)
  assert.match(r.stderr, /count mismatch: expected 3 receipt\(s\), found 2/)
})

test('(c) same truncated file, no pin → 0 (default unchanged)', () => {
  const r = verify(tailCut)
  assert.equal(r.status, 0, `default path must stay 0, got ${r.status}\n${r.stderr}`)
})

test('(d) --expect-last-hash correct → 0, wrong → 11', () => {
  const ok = verify(VECTOR, ['--expect-last-hash', LAST])
  assert.equal(ok.status, 0, ok.stderr)
  const bad = verify(VECTOR, ['--expect-last-hash', WRONG])
  assert.equal(bad.status, 11, `wrong last-hash must be 11, got ${bad.status}`)
  assert.match(bad.stderr, /last-hash mismatch/)
})

test('(e) KIRMA: empty file + --expect-count 1 → 11', () => {
  const r = verify(empty, ['--expect-count', '1'])
  assert.equal(r.status, 11, `expected 11, got ${r.status}\n${r.stderr}`)
  assert.match(r.stderr, /count mismatch: expected 1 receipt\(s\), found 0/)
})

test('empty file, no pin → 0, stderr says this is not a verification', () => {
  const r = verify(empty)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /not a verification that nothing was deleted/)
})

test('truncated JSONL line is exit 20, not a silent skip', () => {
  const broken = path.join(tmp, 'truncated-line.jsonl')
  fs.writeFileSync(broken, full[0] + '\n{"v":"0.3","id":\n')
  const r = verify(broken)
  assert.equal(r.status, 20, `expected 20, got ${r.status}\n${r.stderr}\n${r.stdout}`)
  // 0.2.45 reworded this: the old text said "invalid JSON" for every parse
  // failure, including files that were valid JSON and merely not JSONL. This
  // one is genuinely not valid JSON, so it keeps 20 and says so — and the
  // assertion names the line, which is the part a reader acts on.
  assert.match(`${r.stderr}${r.stdout}`, /truncated-line\.jsonl:2 is not valid JSON/)
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
process.exit(failCount > 0 ? 1 : 0)
