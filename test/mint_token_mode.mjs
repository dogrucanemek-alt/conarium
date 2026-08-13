/**
 * mint-token.mjs must birth the tokens file at 0600, not write-then-chmod.
 * KIRMA: drop `mode: 0o600` from writeFileSync → this source pin goes red.
 * POSIX: after a fresh mint, stat mode & 0777 is 0600.
 * Windows: mode is ignored — SKIP, not a silent pass.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MINT = path.join(here, '..', 'examples', 'per-user-identity', 'mint-token.mjs')
const KEYS = path.join(here, '..', 'src', 'keys.ts')
const INIT = path.join(here, '..', 'bin', 'conarium-init.mjs')
const src = readFileSync(MINT, 'utf8')
const keysSrc = readFileSync(KEYS, 'utf8')
const initSrc = readFileSync(INIT, 'utf8')

assert.match(
  src,
  /writeFileSync\([\s\S]*?mode:\s*0o600/,
  'KIRMA: writeFileSync must pass mode: 0o600 — chmod-after is not the birth permission',
)
assert.match(src, /chmodSync\(file,\s*0o600\)/, 'chmod stays as a backstop for an already-wide file')
assert.match(
  keysSrc,
  /writeFileSync\(privatePath[\s\S]*?mode:\s*0o600/,
  'keys.ts private key must be born at 0600 (same window as #16)',
)
assert.match(
  initSrc,
  /writeFileSync\(signingKeyPath[\s\S]*?mode:\s*0o600/,
  'conarium-init signing key must be born at 0600',
)

if (process.platform === 'win32') {
  console.log('SKIP  ::  POSIX mode 0600 (windows ignores fs mode)')
  console.log('PASS  ::  mint-token writeFileSync carries mode: 0o600 (source pin)')
  process.exit(0)
}

const dir = mkdtempSync(path.join(tmpdir(), 'conarium-mint-'))
const file = path.join(dir, 'conarium.tokens.json')
const r = spawnSync(process.execPath, [MINT, '--id', 'emekcan', '--file', file], {
  encoding: 'utf8',
})
assert.equal(r.status, 0, r.stderr || r.stdout)
const mode = statSync(file).mode & 0o777
assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
assert.doesNotMatch(readFileSync(file, 'utf8'), /token\s+[A-Za-z0-9_-]{20,}/)
console.log('PASS  ::  mint-token births the file at 0600')
process.exit(0)
