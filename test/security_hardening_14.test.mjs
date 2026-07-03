import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import chatHandler, { __test as chatTest } from '../api/chat.js'
import { Audit } from '../dist/audit.js'
import { parseConariumConfig } from '../dist/config.js'
import { createConnector } from '../dist/connectors/index.js'
import { DocsConnector } from '../dist/connectors/docs.js'
import { JiraConnector } from '../dist/connectors/jira.js'
import { OpenApiConnector } from '../dist/connectors/openapi.js'
import { PostgresConnector } from '../dist/connectors/postgres.js'
import { SlackConnector } from '../dist/connectors/slack.js'
import { createConsoleApp, DEFAULT_CONSOLE_HOST, redactSecretFields, validateConsoleConfig } from '../dist/console.js'
import { executeOpenApiTool } from '../dist/executor.js'
import { Governance, PolicyError } from '../dist/governance.js'
import { readGovernedSchemaResource, resolveGovernedSearchScope } from '../dist/search_policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push(['PASS', name])
    pass++
  } catch (err) {
    results.push(['FAIL', name, err.message])
    fail++
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conarium-test-'))
}

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

async function httpRequest(port, method, route, headers = {}, body) {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    }, res => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

await check('1 resources/read filters tables and audits schema reads', async () => {
  const described = []
  const auditEntries = []
  const conn = {
    name: 'mock',
    description: 'Mock',
    capabilities: { canQuery: false, canListSchema: true, canDescribeTable: true, canSearch: false },
    async connect() {},
    async disconnect() {},
    async listTables() {
      return [
        { schema: 'public', name: 'allowed', columns: [] },
        { schema: 'secret', name: 'customers', columns: [] },
      ]
    },
    async describeTable(table) {
      described.push(table)
      return { schema: table.split('.')[0], name: table.split('.')[1], columns: [] }
    },
    async query() { throw new Error('not used') },
    async search() { throw new Error('not used') },
  }
  const content = await readGovernedSchemaResource(
    conn,
    new Governance({ allowTables: ['public.allowed'] }),
    { log: entry => auditEntries.push(entry) },
    'conarium://mock/schema'
  )
  assert.deepEqual(described, ['public.allowed'])
  assert.equal(JSON.parse(content.text).length, 1)
  assert.equal(auditEntries.at(-1).tool, 'read_resource')
  assert.equal(auditEntries.at(-1).denied, false)
})

await check('2 search denies empty scope and connectors honor allowed scopes', async () => {
  const noScope = {
    name: 'empty',
    description: 'empty',
    capabilities: { canQuery: false, canListSchema: true, canDescribeTable: false, canSearch: true },
    async connect() {},
    async disconnect() {},
    async listTables() { return [] },
    async describeTable() { throw new Error('not used') },
    async query() { throw new Error('not used') },
    async search() { throw new Error('search should not run') },
  }
  await assert.rejects(
    resolveGovernedSearchScope(noScope, new Governance(), 'needle'),
    /no allowed scope/
  )

  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.md'), 'needle alpha')
  fs.writeFileSync(path.join(dir, 'b.md'), 'needle beta')
  const docs = new DocsConnector({ type: 'docs', name: 'docs', description: 'Docs', config: { path: dir } })
  await docs.connect()
  const tables = await docs.listTables()
  const result = await docs.search('needle', [`docs.${tables[0].name}`])
  assert.equal(result.rowCount, 1)
  assert.equal(result.rows[0]._table, `docs.${tables[0].name}`)

  const slack = new SlackConnector({ type: 'slack', name: 'slack', description: 'Slack', config: {} })
  assert.equal((await slack.search('needle', ['slack.not_allowed'])).rowCount, 0)
  const jira = new JiraConnector({ type: 'jira', name: 'jira', description: 'Jira', config: {} })
  assert.equal((await jira.search('needle', ['jira.not_allowed'])).rowCount, 0)
})

await check('3 chat proxy requires caller auth, env key, HTTPS upstream, and rate limits', async () => {
  const oldEnv = { ...process.env }
  const oldFetch = global.fetch
  try {
    chatTest.rateBuckets.clear()
    process.env.CONARIUM_CHAT_AUTH_TOKEN = 'client-secret'
    process.env.CONARIUM_PROXY_KEY = 'rotated-upstream-key'
    process.env.CONARIUM_CHAT_UPSTREAM_URL = 'http://example.com/chat'
    let res = mockRes()
    await chatHandler({ method: 'POST', headers: { authorization: 'Bearer client-secret' }, body: {} }, res)
    assert.equal(res.statusCode, 502)

    process.env.CONARIUM_CHAT_UPSTREAM_URL = 'https://example.com/chat'
    let captured
    global.fetch = async (url, opts) => {
      captured = { url, opts }
      return { json: async () => ({ reply: 'ok' }) }
    }
    res = mockRes()
    await chatHandler({ method: 'POST', headers: {}, body: {} }, res)
    assert.equal(res.statusCode, 401)
    res = mockRes()
    await chatHandler({ method: 'POST', headers: { authorization: 'Bearer client-secret' }, body: { q: 'x' } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(captured.url.toString(), 'https://example.com/chat')
    assert.equal(captured.opts.headers['x-conarium-key'], 'rotated-upstream-key')
  } finally {
    process.env = oldEnv
    global.fetch = oldFetch
    chatTest.rateBuckets.clear()
  }
})

await check('3b chat public mode (no token) allows anonymous; origin allowlist enforced when set', async () => {
  const oldEnv = { ...process.env }
  const oldFetch = global.fetch
  try {
    delete process.env.CONARIUM_CHAT_AUTH_TOKEN
    delete process.env.CONARIUM_CHAT_ALLOWED_ORIGINS
    process.env.CONARIUM_PROXY_KEY = 'rotated-upstream-key'
    process.env.CONARIUM_CHAT_UPSTREAM_URL = 'https://example.com/chat'
    global.fetch = async () => ({ json: async () => ({ reply: 'ok' }) })

    // public mode: no token configured, no auth header -> allowed
    chatTest.rateBuckets.clear()
    let res = mockRes()
    await chatHandler({ method: 'POST', headers: {}, body: {} }, res)
    assert.equal(res.statusCode, 200)

    // origin allowlist set: disallowed origin -> 403
    process.env.CONARIUM_CHAT_ALLOWED_ORIGINS = 'https://conarium.dev'
    chatTest.rateBuckets.clear()
    res = mockRes()
    await chatHandler({ method: 'POST', headers: { origin: 'https://evil.example' }, body: {} }, res)
    assert.equal(res.statusCode, 403)

    // allowed origin -> 200
    chatTest.rateBuckets.clear()
    res = mockRes()
    await chatHandler({ method: 'POST', headers: { origin: 'https://conarium.dev' }, body: {} }, res)
    assert.equal(res.statusCode, 200)

    // referer host fallback when origin header absent -> 200
    chatTest.rateBuckets.clear()
    res = mockRes()
    await chatHandler({ method: 'POST', headers: { referer: 'https://conarium.dev/index.html' }, body: {} }, res)
    assert.equal(res.statusCode, 200)
  } finally {
    process.env = oldEnv
    global.fetch = oldFetch
    chatTest.rateBuckets.clear()
  }
})

await check('4 console is loopback by default, authenticated, CSRF-protected, validated, and redacts secrets', async () => {
  assert.equal(DEFAULT_CONSOLE_HOST, '127.0.0.1')
  assert.deepEqual(redactSecretFields({ config: { serviceKey: 'secret', url: 'postgres://pw', ok: 'yes' } }), {
    config: { serviceKey: '[REDACTED]', url: '[REDACTED]', ok: 'yes' },
  })
  assert.throws(() => validateConsoleConfig({ maxRows: 1, unknown: true }), /Unrecognized key/)

  const oldEnv = { ...process.env }
  const dir = tempDir()
  const app = createConsoleApp({
    configFile: path.join(dir, 'console.json'),
    auditFile: path.join(dir, 'audit.jsonl'),
  })
  process.env.CONARIUM_CONSOLE_TOKEN = 'console-token'
  process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf-token'
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port
    assert.equal((await httpRequest(port, 'GET', '/api/config')).status, 401)
    assert.equal((await httpRequest(port, 'POST', '/api/config', { authorization: 'Bearer console-token' }, { maxRows: 1 })).status, 403)
    assert.equal((await httpRequest(
      port,
      'POST',
      '/api/config',
      { authorization: 'Bearer console-token', 'x-csrf-token': 'csrf-token' },
      { maxRows: 10, allowTools: ['*'], denyTools: [], piiMasking: true }
    )).status, 200)
  } finally {
    await new Promise(resolve => server.close(resolve))
    process.env = oldEnv
  }
})

await check('5 Telegram/Supabase script secrets are loaded from env, not source literals', async () => {
  const unified = fs.readFileSync(path.join(repoRoot, 'src/scripts/unified_poller.py'), 'utf8')
  const engine = fs.readFileSync(path.join(repoRoot, 'src/scripts/content_engine.py'), 'utf8')
  const bridge = fs.readFileSync(path.join(repoRoot, 'src/scripts/poll_bridge.py'), 'utf8')
  const tokenPattern = /\d{9,}:[A-Za-z0-9_-]{20,}/
  assert.equal(tokenPattern.test(unified), false)
  assert.equal(tokenPattern.test(engine), false)
  assert.equal(/sb_publishable_[A-Za-z0-9_-]+/.test(bridge), false)
  assert.match(unified, /CONARIUM_TELEGRAM_BOT_TOKEN/)
  assert.match(engine, /CONARIUM_SUPABASE_PUBLISHABLE_KEY/)
  assert.match(bridge, /CONARIUM_SUPABASE_PUBLISHABLE_KEY/)
})

await check('6 Supabase content_queue RLS removes anon read/update and scopes owner/status', async () => {
  const sql = fs.readFileSync(path.join(repoRoot, 'supabase_content_queue.sql'), 'utf8')
  assert.doesNotMatch(sql, /TO\s+anon[\s\S]*FOR\s+(SELECT|UPDATE)/i)
  assert.match(sql, /REVOKE ALL ON content_queue FROM anon/i)
  assert.match(sql, /owner_id = auth\.uid\(\)/i)
  assert.match(sql, /status = 'pending'/i)
})

await check('7 OpenAPI connector blocks SSRF and ignores remote servers by default', async () => {
  const blocked = new OpenApiConnector({
    type: 'openapi',
    name: 'blocked',
    description: 'Blocked',
    config: { url: 'https://127.0.0.1/openapi.json', allowedBaseUrls: 'https://127.0.0.1' },
  })
  await assert.rejects(blocked.connect(), /private\/reserved/)

  const dir = tempDir()
  const spec = path.join(dir, 'openapi.json')
  fs.writeFileSync(spec, JSON.stringify({
    openapi: '3.0.0',
    servers: [{ url: 'https://evil.example.com' }],
    paths: { '/users': { get: { summary: 'Get users' } } },
  }))
  const local = new OpenApiConnector({
    type: 'openapi',
    name: 'local',
    description: 'Local',
    config: { url: spec },
  })
  await local.connect()
  assert.equal((await local.listTables())[0].name, 'GET /users')
})

await check('8 search enforces min length and Docs caps traversal/results/bytes', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.md'), 'needle a')
  fs.writeFileSync(path.join(dir, 'b.md'), 'needle b')
  fs.writeFileSync(path.join(dir, 'huge.md'), 'needle '.repeat(1000))
  const docs = new DocsConnector({
    type: 'docs',
    name: 'docs',
    description: 'Docs',
    config: { path: dir, maxSearchResults: '1', maxFileBytes: '100', maxSearchBytes: '10000' },
  })
  await docs.connect()
  await assert.rejects(resolveGovernedSearchScope(docs, new Governance({ allowTables: ['docs.*'] }), 'ab'), /at least 3/)
  const result = await docs.search('needle')
  assert.equal(result.rowCount, 1)
  assert.notEqual(result.rows[0].file, 'huge.md')
})

await check('9 audit.failClosed is passed from config into Audit construction', async () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8')
  assert.match(indexSource, /failClosed:\s*config\.audit\?\.failClosed/)
})

await check('10 audit hash chain fails closed on corrupt state', async () => {
  const dir = tempDir()
  const sink = path.join(dir, 'audit.jsonl')
  fs.writeFileSync(sink, '{not-json}\n')
  assert.throws(() => new Audit({ sink }), /Audit sink is corrupt/)

  const valid = path.join(dir, 'valid.jsonl')
  const audit = new Audit({ sink: valid })
  audit.log({ tool: 'query', denied: false })
  assert.doesNotThrow(() => new Audit({ sink: valid }))
})

await check('11 public audit log rendering uses textContent instead of innerHTML for log fields', async () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8')
  assert.doesNotMatch(app, /tr\.innerHTML\s*=/)
  assert.match(app, /textContent\s*=/)
})

await check('12 OpenAPI executor enforces methods, encodes path params, and uses URL construction', async () => {
  await assert.rejects(
    executeOpenApiTool({ method: 'POST', path: '/pets', args: {} }, { baseUrl: 'https://api.example.com' }, async () => ({})),
    /not allowed/
  )

  let capturedUrl = ''
  await executeOpenApiTool(
    { method: 'GET', path: '/pets/{petId}', args: { petId: 'a/b c', q: 'x y' } },
    { baseUrl: 'https://api.example.com/v1' },
    async (url) => {
      capturedUrl = url
      return {
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ ok: true }),
      }
    }
  )
  assert.equal(capturedUrl, 'https://api.example.com/v1/pets/a%2Fb%20c?q=x+y')
})

await check('13 PostgresConnector query is read-only guarded without unsafe param any bypass', async () => {
  const pg = new PostgresConnector({ type: 'postgres', name: 'pg', description: 'PG', config: { mock: 'true' } })
  await assert.rejects(pg.query('DELETE FROM public.users WHERE id = 1'), /read-only|write operation/)
  const result = await pg.query('SELECT * FROM public.users')
  assert.equal(result.rowCount, 1)
})

await check('14 Conarium config and connector creation reject missing/unknown fields at runtime', async () => {
  assert.throws(() => parseConariumConfig({ connectors: [{ type: 'docs', name: 'docs', config: {} }] }), /description/)
  assert.throws(() => parseConariumConfig({ connectors: [], unexpected: true }), /Unrecognized key/)
  assert.throws(() => createConnector({ type: 'docs', name: 'docs', description: 'Docs', config: {}, extra: true }), /Unrecognized key/)
})

for (const result of results) console.log(result.join('  ::  '))
console.log(`\nSummary: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
