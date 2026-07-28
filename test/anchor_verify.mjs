/**
 * A6.5–A6.7 — conarium-verify --anchor-check with committed OpenTimestamps fixtures.
 * No TESTOTS stubs in the verifier. Fixtures under test/fixtures/ots/ (no private keys).
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERIFY = join(ROOT, 'bin', 'conarium-verify.mjs')
const FIX = join(ROOT, 'test', 'fixtures', 'ots')

function runVerify(args) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' }
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-av-'))
  const pub = join(FIX, 'pubkey.pem')
  const chainPending = readFileSync(join(FIX, 'chain-pending.jsonl'), 'utf-8').trim()
  const receipt = JSON.parse(chainPending)
  const matchingOtsB64 = readFileSync(join(FIX, 'pending-matching.ots')).toString('base64')
  const wrongOtsB64 = readFileSync(join(FIX, 'other-ffff.ots')).toString('base64')

  // A6.5 — anchor stripped
  const chainPath = join(dir, 'chain.jsonl')
  const anchorsPath = `${chainPath}.anchors.jsonl`
  writeFileSync(chainPath, JSON.stringify({ ...receipt, anchor: null }) + '\n')
  let res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.5 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor missing/)

  // A6.6 — real pending OTS matching chain.hash → 0 + warning
  // verify() may contact calendars for attestation status; digest already matches offline.
  writeFileSync(chainPath, JSON.stringify(receipt) + '\n')
  writeFileSync(
    anchorsPath,
    JSON.stringify({
      seq: receipt.chain.seq,
      hash: receipt.chain.hash,
      log: 'opentimestamps',
      ots: matchingOtsB64,
      state: 'pending',
      submittedAt: '2026-07-29T00:00:00.000Z',
      upgradedAt: null,
      bitcoinBlock: null,
    }) + '\n',
  )
  res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 0, `A6.6 expected 0, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor pending/)

  // A6.7 — OTS for a different digest → 14
  writeFileSync(
    anchorsPath,
    JSON.stringify({
      seq: receipt.chain.seq,
      hash: receipt.chain.hash,
      log: 'opentimestamps',
      ots: wrongOtsB64,
      state: 'pending',
      submittedAt: '2026-07-29T00:00:00.000Z',
      upgradedAt: null,
      bitcoinBlock: null,
    }) + '\n',
  )
  res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.7 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor proof failed|does not match|File does not match/i)

  console.log('anchor-verify tests OK (real OTS fixtures)')
}

main()
