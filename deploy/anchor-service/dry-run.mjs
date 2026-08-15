#!/usr/bin/env node
/**
 * Local dry-run for the anchoring service. Does not talk to calendars or
 * Hetzner. Proves two things the operator will hit:
 *   1. missing env refuses to start and names the variable
 *   2. with env present, GET /healthz returns 200 (pm2 "online" is not this)
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'bin', 'conarium-anchor-service.mjs')

function runOnce(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (status) => resolve({ status, out }))
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
    s.on('error', reject)
  })
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolve(code)
    })
  })
}

const missing = await runOnce({
  CONARIUM_ANCHOR_TOKENS: '',
  CONARIUM_ANCHOR_BASE_URL: '',
})
if (missing.status !== 2) {
  console.error(`expected exit 2 on missing env, got ${missing.status}\n${missing.out}`)
  process.exit(1)
}
if (!/CONARIUM_ANCHOR_TOKENS/.test(missing.out)) {
  console.error(`missing-env refusal did not name CONARIUM_ANCHOR_TOKENS:\n${missing.out}`)
  process.exit(1)
}
console.log('ok  missing env refuses start and names CONARIUM_ANCHOR_TOKENS')

const dir = mkdtempSync(join(tmpdir(), 'conarium-anchor-dry-'))
const tokensPath = join(dir, 'tokens.json')
const storePath = join(dir, 'store.jsonl')
const keyPath = join(dir, 'anchor.pem')
writeFileSync(tokensPath, JSON.stringify({ 'dry-run-token': 'dry-run-owner' }) + '\n')

const missingKey = await runOnce({
  CONARIUM_ANCHOR_TOKENS: tokensPath,
  CONARIUM_ANCHOR_BASE_URL: 'http://127.0.0.1:1',
  CONARIUM_ANCHOR_SIGNING_KEY: '',
})
if (missingKey.status !== 2) {
  console.error(`expected exit 2 on missing signing key, got ${missingKey.status}\n${missingKey.out}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
if (!/CONARIUM_ANCHOR_SIGNING_KEY/.test(missingKey.out)) {
  console.error(`missing-key refusal did not name CONARIUM_ANCHOR_SIGNING_KEY:\n${missingKey.out}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
console.log('ok  missing signing key refuses start and names CONARIUM_ANCHOR_SIGNING_KEY')

const pair = generateKeyPairSync('ed25519')
writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
writeFileSync(keyPath + '.keyid', 'dry-run-key\n')
const port = await freePort()

const child = spawn(process.execPath, [BIN], {
  env: {
    ...process.env,
    CONARIUM_ANCHOR_TOKENS: tokensPath,
    CONARIUM_ANCHOR_BASE_URL: 'http://127.0.0.1:' + port,
    CONARIUM_ANCHOR_SIGNING_KEY: keyPath,
    CONARIUM_ANCHOR_STORE: storePath,
    CONARIUM_ANCHOR_HOST: '127.0.0.1',
    CONARIUM_ANCHOR_PORT: String(port),
    CONARIUM_ANCHOR_UPGRADE_MINUTES: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let started = ''
child.stdout.on('data', (d) => { started += d })
child.stderr.on('data', (d) => { started += d })

const early = await waitExit(child, 4000)
if (early !== null) {
  console.error(`service exited before listen: ${early}\n${started}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

let health
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  health = { status: res.status, body: await res.text() }
} catch (e) {
  child.kill('SIGTERM')
  console.error(`healthz request failed: ${e.message}\n${started}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

child.kill('SIGTERM')
await waitExit(child, 2000)
try { child.kill('SIGKILL') } catch { /* already gone */ }
rmSync(dir, { recursive: true, force: true })

if (health.status !== 200) {
  console.error(`healthz expected 200, got ${health.status}: ${health.body}`)
  process.exit(1)
}
if (!/"ok"\s*:\s*true/.test(health.body) && !/"ok":true/.test(health.body)) {
  console.error(`healthz body missing ok:true: ${health.body}`)
  process.exit(1)
}
console.log(`ok  GET /healthz → ${health.status} ${health.body}`)
console.log('dry-run passed')
process.exit(0)
