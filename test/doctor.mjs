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
import http from 'http'
import {
  dialectAgrees,
  familyFromBanner,
  resolveDoctorDialect,
} from '../bin/doctor-sql.mjs'

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

test('maxRows above the measured threshold is a warning, not a failure', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, policy: { ...HEALTHY.policy, maxRows: 500 } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, `warning must not fail the doctor:\n${out}`)
  assert.ok(/maxRows/.test(out), 'must name maxRows')
  assert.ok(/distinct/.test(out), 'must say cost grows with distinct masked values')
  assert.ok(/not rejected/.test(out), 'must say the query is not rejected')
})

test('default maxRows does not warn', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, policy: { ...HEALTHY.policy, maxRows: 100 } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(!/measured warning above/.test(out), `default cap must stay silent:\n${out}`)
})

test('a healthy config exits 0', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, `expected clean exit, got ${status}:\n${out}`)
})

test('maskColumns without protectedColumns is a warning, not a failure', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, `cross-check must not fail the doctor:\n${out}`)
  assert.ok(/maskColumns/.test(out) && /protectedColumns/.test(out), out)
  assert.ok(/\*\.email/.test(out), 'must name the uncovered column')
  assert.ok(/unlearnable/.test(out), 'must cite the LIMITATIONS heading')
  assert.ok(/valid choice — make sure it is a choice/.test(out), 'must keep the existing choice language')
})

test('maskColumns also listed in protectedColumns does not warn', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    policy: { ...HEALTHY.policy, protectedColumns: ['*.email'] },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(!/valid choice — make sure it is a choice/.test(out), `matched lists must stay quiet:\n${out}`)
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

// --- version check (G3) -------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

test('--no-net does not query the npm registry', async () => {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits += 1
    res.end(JSON.stringify({ version: '9.9.9' }))
  })
  const port = await listen(server)
  try {
    const dir = tmpdir()
    writeConfig(dir, HEALTHY)
    const { status, out } = runDoctor(dir, {
      env: {
        CONARIUM_AUDIT_UNSIGNED: '1',
        CONARIUM_NPM_REGISTRY: `http://127.0.0.1:${port}/@conarium-ai/core/latest`,
      },
      args: ['--no-net'],
    })
    assert.strictEqual(status, 0, out)
    assert.strictEqual(hits, 0, 'fetch must not run under --no-net')
    assert.ok(/registry not queried/.test(out), 'must say the registry was skipped')
  } finally {
    server.close()
  }
})

test('unreachable registry is a warning, doctor still exits 0', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    serverName: 'Conarium',
    consumer: 'ai-assistant',
    connectors: [{ type: 'docs', name: 'docs', description: 'local docs', config: { root: './docs' } }],
    policy: { allowConnectors: ['docs'], maskColumns: ['*.email'] },
  })
  const { status, out } = runDoctor(dir, {
    args: [],
    env: {
      CONARIUM_AUDIT_UNSIGNED: '1',
      CONARIUM_NPM_REGISTRY: 'http://127.0.0.1:1/@conarium-ai/core/latest',
    },
  })
  assert.strictEqual(status, 0, `registry down must not fail the doctor:\n${out}`)
  assert.ok(/registry unreachable/.test(out), 'must warn, not stay silent')
})

// --- dialect / PII surface (must not stay silent) -----------------------------

test('omitted dialect is written as default postgres, not left silent', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(/SQL dialect/.test(out), 'must name the dialect check')
  assert.ok(/postgres \(default/.test(out), 'must say the default is postgres')
  assert.ok(/SQL gate/.test(out), 'must say whether the gate loads')
  assert.ok(/policy\.maxRows/.test(out), 'maxRows must appear even when it does not warn')
  assert.ok(/policy\.customPatterns/.test(out), 'customPatterns must appear even when empty')
  assert.ok(/0 custom patterns/.test(out))
})

test('unknown dialect is FAIL — not a silent postgres fallback', async () => {
  const dir = tmpdir()
  writeConfig(dir, { ...HEALTHY, policy: { ...HEALTHY.policy, dialect: 'mysql' } })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1, out)
  assert.ok(/SQL dialect/.test(out))
  assert.ok(/mysql/.test(out))
  assert.ok(/not allowed/.test(out))
})

test('oracle dialect + postgres DSN is FAIL (test pair)', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    policy: { ...HEALTHY.policy, dialect: 'oracle' },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1, `mismatch must fail:\n${out}`)
  assert.ok(/Engine identity/.test(out), 'must name the identity check')
  assert.ok(/oracle/.test(out))
  assert.ok(/postgres/.test(out))
  assert.ok(/FAIL/.test(out))
})

test('unreachable engine is unseen, not a pass', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    connectors: [{ type: 'postgres', name: 'maindb', config: { url: 'postgresql://u:p@127.0.0.1:1/db' } }],
  })
  const { status, out } = runDoctor(dir, { args: [], env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1, `reachability still fails:\n${out}`)
  assert.ok(/unseen/.test(out), 'identity must be unseen, not ok')
  assert.ok(/not checked \(host unreachable\)/.test(out))
  assert.ok(!/matches policy\.dialect/.test(out), 'must not claim a match')
})

test('--no-net engine identity is unseen, not a pass', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(/Engine identity/.test(out))
  assert.ok(/not checked \(--no-net\)/.test(out))
  assert.ok(/unseen/.test(out))
  assert.ok(!/This install is ready/.test(out), 'unseen must not claim the install is ready')
})

test('custom pattern names appear; pattern text does not', async () => {
  const dir = tmpdir()
  const secretPattern = 'TR\\d{24}-DO-NOT-PRINT-PATTERN-9911'
  writeConfig(dir, {
    ...HEALTHY,
    policy: {
      ...HEALTHY.policy,
      customPatterns: [{ name: 'acct-iban', pattern: secretPattern, label: '[MASKED_PII]' }],
    },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.ok(status === 0 || status === 1, out)
  assert.ok(/acct-iban/.test(out), 'rule name must be visible')
  assert.ok(!out.includes(secretPattern), 'pattern text leaked')
  assert.ok(!out.includes('DO-NOT-PRINT-PATTERN-9911'), 'pattern fragment leaked')
})

test('custom pattern without a sample is unseen, not a silent pass', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    policy: {
      ...HEALTHY.policy,
      customPatterns: [{ name: 'acct-iban', pattern: 'TR[0-9]{24}', label: '[MASKED_PII]' }],
    },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(/unseen/.test(out), out)
  assert.ok(/acct-iban/.test(out) && /not tested/.test(out), out)
})

test('custom pattern sample match is ok; mismatch is warn; sample text stays hidden', async () => {
  const dir = tmpdir()
  const secretSample = 'XX-DO-NOT-PRINT-SAMPLE-9911'
  writeConfig(dir, {
    ...HEALTHY,
    policy: {
      ...HEALTHY.policy,
      customPatterns: [
        { name: 'hesap-ok', pattern: 'HSP-[0-9]{8}', sample: 'HSP-12345678', label: '[MASKED_PII]' },
        { name: 'hesap-miss', pattern: 'HSP-[0-9]{8}', sample: secretSample, label: '[MASKED_PII]' },
      ],
    },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, `sample mismatch is a warning, not a fail:\n${out}`)
  assert.ok(/hesap-ok/.test(out) && /matched its sample/.test(out), out)
  assert.ok(/pattern hesap-miss compiled but did not match its own sample/.test(out), out)
  assert.ok(!out.includes(secretSample), 'sample text leaked')
  assert.ok(!out.includes('DO-NOT-PRINT-SAMPLE'), 'sample fragment leaked')
  assert.ok(!out.includes('HSP-12345678'), 'matching sample leaked')
})

test('fake engine banner vs dialect: postgres banner is not oracle', () => {
  assert.strictEqual(familyFromBanner('PostgreSQL 16.2 on x86_64-pc-linux-gnu'), 'postgres')
  assert.strictEqual(familyFromBanner('Microsoft SQL Server 2022'), 'mssql')
  assert.strictEqual(familyFromBanner('Oracle Database 23ai Free'), 'oracle')
  assert.strictEqual(familyFromBanner('something else'), null)
  assert.strictEqual(dialectAgrees('oracle', familyFromBanner('PostgreSQL 16.2')), false)
  assert.strictEqual(dialectAgrees('postgres', familyFromBanner('PostgreSQL 16.2')), true)
  assert.deepStrictEqual(resolveDoctorDialect(undefined), { dialect: 'postgres', source: 'default' })
  assert.throws(() => resolveDoctorDialect('mysql'), /not allowed/)
})

// --- exit contract with the network probe on -----------------------------------

test('an unreachable connector exits 1 — not an abort', async () => {
  // Regression. The probe resolved on the socket's error event and the process
  // exited while the handle was still closing; on Windows libuv asserted and the
  // run ended with 127. 127 is not one of this tool's codes, and a deployment
  // gate reading the exit status cannot act on it.
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    connectors: [{ type: 'postgres', name: 'maindb', config: { url: 'postgresql://u:p@127.0.0.1:1/db' } }],
  })
  const { status, out } = runDoctor(dir, { args: [], env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.ok(!/Assertion failed/.test(out), 'the process aborted instead of exiting cleanly')
  assert.strictEqual(status, 1, `unreachable connector must exit 1, got ${status}`)
  assert.ok(/Reachability/.test(out), 'the failure must be named')
})

test('custom-sql is named and dialect omission is FAIL', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    serverName: 'Conarium',
    consumer: 'ai-assistant',
    connectors: [{ type: 'custom-sql', name: 'memory', description: 'op', config: { module: './x.mjs' } }],
    policy: { allowConnectors: ['memory'], allowTables: ['public.customers'] },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 1, out)
  assert.ok(/custom-sql/.test(out), 'must name the executor check')
  assert.ok(/operator executor/.test(out))
  assert.ok(/custom-sql dialect/.test(out))
  assert.ok(/omitted/.test(out))
})

test('custom-sql with declared dialect is visible and not a fail on that line', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    serverName: 'Conarium',
    consumer: 'ai-assistant',
    connectors: [{ type: 'custom-sql', name: 'memory', description: 'op', config: { module: './x.mjs' } }],
    policy: { dialect: 'oracle', allowConnectors: ['memory'], allowTables: ['app.customers'] },
  })
  const { out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.ok(/custom-sql/.test(out), out)
  assert.ok(/declared oracle/.test(out), out)
  assert.ok(!/FAIL\s+custom-sql dialect/.test(out), out)
})

test('receipt schema version and undeclared destination appear; never "destination safe"', async () => {
  const dir = tmpdir()
  writeConfig(dir, HEALTHY)
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(/Receipt schema/.test(out) && /conarium-receipt\/0\.4/.test(out), out)
  assert.ok(/Receipt destination/.test(out) && /undeclared/.test(out), out)
  assert.ok(!/destination güvenli|destination safe|destination verified/i.test(out), out)
})

test('declared destination is named as operator-declared, not verified', async () => {
  const dir = tmpdir()
  writeConfig(dir, {
    ...HEALTHY,
    audit: { receiptDestination: 'openai/gpt-x' },
  })
  const { status, out } = runDoctor(dir, { env: { CONARIUM_AUDIT_UNSIGNED: '1' } })
  assert.strictEqual(status, 0, out)
  assert.ok(/Receipt destination/.test(out), out)
  assert.ok(/operator-declared, not verified/.test(out), out)
  assert.ok(!/openai\/gpt-x/.test(out), 'destination value must not be printed')
  assert.ok(!/destination güvenli|destination safe/i.test(out), out)
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
