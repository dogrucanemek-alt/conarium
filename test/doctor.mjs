/**
 * conarium-doctor tests.
 *
 * The doctor's output is meant to be pasted into a support email. Two of these
 * tests exist for that reason alone: the password in a DSN and the value of a
 * token must never reach stdout. A diagnosis tool that leaks credentials turns
 * every support request into an incident.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { generateKeyPairSync } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCTOR = path.join(__dirname, '..', 'bin', 'conarium-doctor.mjs')

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conarium-doctor-'))
}

/** Run the doctor in `cwd`. Network probe off unless a test asks for it. */
function runDoctor(cwd, { env = {}, args = ['--no-net'] } = {}) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env, CONARIUM_AUDIT_SIGNING_KEY: '', CONARIUM_AUDIT_TRUST_PUBKEYS: '', CONARIUM_MCP_TOKEN: '', ...env },
  })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'conarium.config.json'), JSON.stringify(cfg, null, 2))
}

const HEALTHY = {
  serverName: 'Conarium',
  consumer: 'ai-assistant',
  connectors: [{ type: 'postgres', name: 'maindb', config: { url: 'postgresql://u:p@localhost:5432/db' } }],
  policy: { allowConnectors: ['maindb'], allowTables: ['public.customers'], maskColumns: ['*.email'] },
}

// --- the silent failures the tool exists for ---------------------------------

test('missing config is a FAILURE, not a shrug', async () => {
  const dir = tmpdir()
  const { status, out } = runDoctor(dir)
  assert.strictEqual(status, 1, 'missing config must exit 1')
  assert.ok(/Config file/.test(out), 'must name the config check')
  assert.ok(/not found/.test(out), 'must say it was not found')
  assert.ok(/governs nothing|zero connectors/.test(out), 'must explain the silent-start consequence')
})

test('connectors without an allow list are reported fail-closed', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, policy: { allowConnectors: [] } })
  const { status, out } = runDoctor(dir)
  assert.strictEqual(status, 1)
  assert.ok(/allowConnectors/.test(out))
  assert.ok(/fail-closed/.test(out), 'must explain that an empty list permits nothing')
})

test('a healthy config exits 0', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, `expected clean exit, got ${status}:\n${out}`)
})

test('invalid JSON is named as invalid JSON', async () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'conarium.config.json'), '{ "connectors": [ ')
  const { status, out } = runDoctor(dir)
  assert.strictEqual(status, 1)
  assert.ok(/invalid JSON/.test(out))
})

// --- secrets ------------------------------------------------------------------

test('SECRET: the DSN password never reaches stdout', async () => {
  const dir = tmpdir()
  const secret = 'sup3rs3cr3t-pw-do-not-print'
  writeConfig(dir, {
    ...HEALTHY,
    connectors: [{ type: 'postgres', name: 'maindb', config: { url: `postgresql://appuser:${secret}@db.internal:5432/prod` } }],
  })
  const { out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.ok(!out.includes(secret), 'password leaked into doctor output')
  // The negative assertion above is not enough on its own: it also passes when
  // the DSN is never rendered at all, which is how this test was green for the
  // wrong reason once. Pin the redacted shape so the redaction path is really
  // exercised — break the redaction and this line goes red.
  assert.ok(out.includes('db.internal'), 'the host must be shown so the operator knows which endpoint was checked')
  assert.ok(out.includes('appuser'), 'the user must be shown')
  assert.ok(/password set, not shown/.test(out), 'the presence of a password must be stated without printing it')
})

test('SECRET: a DSN taken from env is described, not echoed', async () => {
  const dir = tmpdir()
  const secret = 'env-side-password-9911'
  writeConfig(dir, {
    ...HEALTHY,
    connectors: [{ type: 'postgres', name: 'maindb', config: { url: 'env:MY_DSN' } }],
  })
  const { out } = runDoctor(dir, {
    env: { MY_DSN: `postgresql://appuser:${secret}@db.internal:5432/prod`, CONARIUM_AUDIT_UNSIGNED: '1' },
  })
  assert.ok(!out.includes(secret), 'password from env leaked into doctor output')
})

// --- the keyId sidecar trap ---------------------------------------------------

test('a trusted public key without its .keyid sidecar is a FAILURE', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { publicKey } = generateKeyPairSync('ed25519')
  const pubPath = path.join(dir, 'audit.pub.pem')
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const { status, out } = runDoctor(dir, {
    env: { CONARIUM_AUDIT_TRUST_PUBKEYS: pubPath, CONARIUM_AUDIT_UNSIGNED: '1' },
  })
  assert.strictEqual(status, 1)
  assert.ok(/keyId sidecar/.test(out))
  assert.ok(/exit 13/.test(out), 'must connect the missing sidecar to the symptom the operator will actually see')
})

test('with the sidecar present the same key passes', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { publicKey } = generateKeyPairSync('ed25519')
  const pubPath = path.join(dir, 'audit.pub.pem')
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }))
  fs.writeFileSync(pubPath + '.keyid', 'key-2026-08')
  const { status, out } = runDoctor(dir, {
    env: { CONARIUM_AUDIT_TRUST_PUBKEYS: pubPath, CONARIUM_AUDIT_UNSIGNED: '1' },
  })
  assert.strictEqual(status, 0, out)
})

// --- signing key --------------------------------------------------------------

test('receiptSink without a signing key is a FAILURE', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, audit: { receiptSink: 'receipts.jsonl' } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1)
  assert.ok(/CONARIUM_AUDIT_SIGNING_KEY/.test(out))
})

test('signing key env pointing at a missing file is named as a path problem', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_SIGNING_KEY: path.join(dir, 'nope.pem') } })
  assert.strictEqual(status, 1)
  assert.ok(/missing file/.test(out))
  assert.ok(/FILE path/.test(out), 'must say the env var holds a path, not key material')
})

// --- audit sink ---------------------------------------------------------------

test('an audit sink in a non-existent directory is a FAILURE', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, audit: { sink: path.join(dir, 'no', 'such', 'dir', 'audit.jsonl') } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1)
  assert.ok(/Audit sink/.test(out))
})

// --- profiles vs shared token -------------------------------------------------

test('masking profiles with a shared token warn, but do not fail', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, policy: { ...HEALTHY.policy, profiles: { boss: { maskColumns: [] } } } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_MCP_TOKEN: 'shared-token-value', CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, 'a warning must not fail the run')
  assert.ok(/silently ignored/.test(out), 'must say the profiles do nothing with a shared credential')
  assert.ok(!out.includes('shared-token-value'), 'token value leaked into doctor output')
})

// --- run ----------------------------------------------------------------------

for (const { name, fn } of tests) {
  try {
    await fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}\n        ${err.message}`)
  }
}
console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
process.exit(failCount > 0 ? 1 : 0)
