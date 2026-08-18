#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'conarium-sync-'))
const tokensPath = join(dir, 'anchor.tokens.json')
const original = JSON.stringify({ 'legacy-raw': 'old-customer' }, null, 2)
writeFileSync(tokensPath, original)

function run(fetchImplSrc, extraEnv = {}) {
  const loader = join(dir, `fetch-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
  writeFileSync(loader, `globalThis.__conariumFetch = ${fetchImplSrc}\n`)
  return spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, join(root, 'bin/conarium-token-sync.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONARIUM_SUPABASE_URL: extraEnv.url || 'http://127.0.0.1:9',
      CONARIUM_SUPABASE_SERVICE_ROLE: 'test-role',
      CONARIUM_ANCHOR_TOKENS: tokensPath,
    },
  })
}

const hash = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const ok = run(
  `async () => ({ ok: true, json: async () => [{ token_sha256: '${hash}', owner: 'buyer@example.com' }] })`,
)
assert.equal(ok.status, 0, ok.stderr)
const written = JSON.parse(readFileSync(tokensPath, 'utf8'))
assert.equal(written[`sha256:${hash}`], 'buyer@example.com')
assert.equal(typeof written._conarium_sync, 'string')
assert.equal(written['legacy-raw'], undefined)

writeFileSync(tokensPath, JSON.stringify(written, null, 2))
const before = readFileSync(tokensPath, 'utf8')
const bad = run(`async () => { throw new Error('ECONNREFUSED') }`)
assert.notEqual(bad.status, 0)
assert.match(bad.stderr, /unchanged/)
assert.equal(readFileSync(tokensPath, 'utf8'), before)

const emptyBody = run(`async () => ({ ok: true, json: async () => ({ not: 'array' }) })`)
assert.notEqual(emptyBody.status, 0)
assert.equal(readFileSync(tokensPath, 'utf8'), before)

console.log('ok  token-sync writes sha256 keys and refuses to wipe on error')
