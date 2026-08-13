/**
 * Console policy editor: the form must load real values and saving must not
 * drop connectors, audit, or profiles. A console that silently rewrites a
 * security policy is worse than no console.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import { createConsoleApp, mergeConsolePolicyPatch } from '../dist/console.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conarium-console-policy-'))
}

async function httpRequest(port, method, route, headers = {}, body) {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: route,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined }))
      },
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

const FULL = {
  serverName: 'Conarium',
  consumer: 'ai-assistant',
  connectors: [
    { type: 'postgres', name: 'maindb', description: 'demo', config: { url: 'postgresql://u:p@127.0.0.1:5432/db' } },
  ],
  policy: {
    allowConnectors: ['maindb'],
    allowTables: ['public.accounts'],
    denyTables: ['public.card_vault'],
    maskColumns: ['*.email'],
    maxRows: 50,
    profiles: { controller: { maskColumns: [] } },
    actorProfiles: { emekcan: 'controller' },
  },
  audit: { sink: 'conarium-audit.jsonl', failClosed: true, receiptSink: 'conarium-receipts.jsonl' },
}

test('mergeConsolePolicyPatch keeps connectors, audit and profiles', () => {
  const next = mergeConsolePolicyPatch(FULL, { maskColumns: ['*.tckn', '*.iban'], maxRows: 25 })
  assert.ok(Array.isArray(next.connectors) && next.connectors.length === 1)
  assert.strictEqual(next.connectors[0].name, 'maindb')
  assert.deepStrictEqual(next.audit, FULL.audit)
  assert.deepStrictEqual(next.policy.profiles, FULL.policy.profiles)
  assert.deepStrictEqual(next.policy.actorProfiles, FULL.policy.actorProfiles)
  assert.deepStrictEqual(next.policy.allowConnectors, ['maindb'])
  assert.deepStrictEqual(next.policy.maskColumns, ['*.tckn', '*.iban'])
  assert.strictEqual(next.policy.maxRows, 25)
  assert.deepStrictEqual(next.policy.allowTables, ['public.accounts'])
})

test('GET /api/config returns the file policy, not a hardcoded 100', async () => {
  const dir = tmpdir()
  const configFile = path.join(dir, 'conarium.config.json')
  fs.writeFileSync(configFile, JSON.stringify(FULL, null, 2))
  const oldEnv = { ...process.env }
  process.env.CONARIUM_AUDIT_HMAC_KEY = 'example-not-a-real-key'
  process.env.CONARIUM_CONSOLE_TOKEN = 'tok'
  process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf'
  const app = createConsoleApp({ configFile, auditFile: path.join(dir, 'audit.jsonl') })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise((r) => server.once('listening', r))
    const port = server.address().port
    const { status, body } = await httpRequest(port, 'GET', '/api/config', { authorization: 'Bearer tok' })
    assert.strictEqual(status, 200, JSON.stringify(body))
    assert.strictEqual(body.policy.maxRows, 50, 'must load maxRows from the file, not default 100')
    assert.deepStrictEqual(body.policy.maskColumns, ['*.email'])
    assert.ok(Array.isArray(body.connectors) && body.connectors.length === 1)
  } finally {
    await new Promise((r) => server.close(r))
    process.env = oldEnv
  }
})

test('POST maskColumns does not drop connectors or audit', async () => {
  const dir = tmpdir()
  const configFile = path.join(dir, 'conarium.config.json')
  fs.writeFileSync(configFile, JSON.stringify(FULL, null, 2))
  const oldEnv = { ...process.env }
  process.env.CONARIUM_AUDIT_HMAC_KEY = 'example-not-a-real-key'
  process.env.CONARIUM_CONSOLE_TOKEN = 'tok'
  process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf'
  const app = createConsoleApp({ configFile, auditFile: path.join(dir, 'audit.jsonl') })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise((r) => server.once('listening', r))
    const port = server.address().port
    const { status, body } = await httpRequest(
      port,
      'POST',
      '/api/config',
      { authorization: 'Bearer tok', 'x-csrf-token': 'csrf' },
      { maskColumns: ['*.tckn', '*.iban'] },
    )
    assert.strictEqual(status, 200, JSON.stringify(body))
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.ok(Array.isArray(saved.connectors) && saved.connectors.length > 0, 'connectors must survive a save')
    assert.ok(saved.audit && saved.audit.sink, 'audit must survive a save')
    assert.deepStrictEqual(saved.policy.profiles, FULL.policy.profiles)
    assert.deepStrictEqual(saved.policy.maskColumns, ['*.tckn', '*.iban'])
    assert.strictEqual(saved.policy.maxRows, 50)
    JSON.parse(fs.readFileSync(configFile, 'utf8'))
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    assert.deepStrictEqual(leftovers, [], 'atomic write must not leave a temp file')
  } finally {
    await new Promise((r) => server.close(r))
    process.env = oldEnv
  }
})

test('POST empty allowTables reports allowTablesEmpty', async () => {
  const dir = tmpdir()
  const configFile = path.join(dir, 'conarium.config.json')
  fs.writeFileSync(configFile, JSON.stringify(FULL, null, 2))
  const oldEnv = { ...process.env }
  process.env.CONARIUM_AUDIT_HMAC_KEY = 'example-not-a-real-key'
  process.env.CONARIUM_CONSOLE_TOKEN = 'tok'
  process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf'
  const app = createConsoleApp({ configFile, auditFile: path.join(dir, 'audit.jsonl') })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise((r) => server.once('listening', r))
    const port = server.address().port
    const { status, body } = await httpRequest(
      port,
      'POST',
      '/api/config',
      { authorization: 'Bearer tok', 'x-csrf-token': 'csrf' },
      { allowTables: [] },
    )
    assert.strictEqual(status, 200, JSON.stringify(body))
    assert.strictEqual(body.allowTablesEmpty, true)
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    assert.ok(/allowTables-warn/.test(html), 'the empty-list warning must be in the UI')
    assert.ok(/fail-closed/.test(html))
  } finally {
    await new Promise((r) => server.close(r))
    process.env = oldEnv
  }
})

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
process.exitCode = failCount > 0 ? 1 : 0
