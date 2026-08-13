/**
 * Remote HTTP gateway — live process, live socket, live fetch.
 *
 * session_owner.test.mjs calls createHandler with a fake req. This file
 * starts `dist/http.js` as a child, binds port 0, and speaks MCP Streamable
 * HTTP the way a client does. The 10-hour demo outage (restart → stale
 * Mcp-Session-Id → 400 text/plain → "Invalid content") was on this path;
 * a unit test of the handler cannot see SSE framing or the session header.
 *
 * SSE is parsed as frames (`event:` + `data:`). Searching the body for a
 * JSON object would go green on a text/plain error that happened to contain
 * a brace.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeKeyPairFiles } from '../dist/keys.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const httpJs = join(root, 'dist', 'http.js')
const verifyJs = join(root, 'bin', 'conarium-verify.mjs')

const SHARED = 'e2e-shared-token-at-least-24ch'
const PERSON = 'e2e-person-token-at-least-24ch'
const EMAIL = 'alice@example.com'

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

function countLines(p) {
  if (!existsSync(p)) return 0
  const t = readFileSync(p, 'utf8').trim()
  return t ? t.split('\n').filter(Boolean).length : 0
}

/**
 * MCP Streamable HTTP uses SSE. A frame is event + data, separated by a blank
 * line. This does not JSON.parse the raw body.
 */
function parseSseFrames(body) {
  const frames = []
  const blocks = String(body).split(/\r?\n\r?\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    frames.push({ event, data: JSON.parse(dataLines.join('\n')) })
  }
  return frames
}

function rpcFromSse(body) {
  const frames = parseSseFrames(body)
  const msg = frames.find((f) => f.event === 'message')
  if (!msg) throw new Error(`no event: message frame in SSE (${frames.length} frames)`)
  return msg.data
}

async function rpc(url, { token, sessionId, payload, expectStatus }) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  const ctype = res.headers.get('content-type') || ''
  if (expectStatus !== undefined) {
    assert.equal(res.status, expectStatus, `status ${res.status} body=${text.slice(0, 200)}`)
  }
  return { res, text, ctype, sessionId: res.headers.get('mcp-session-id') }
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`gateway did not become ready. stderr:\n${buf}`))
    }, 15_000)
    const onData = (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/remote MCP hazır — http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) {
        cleanup()
        resolve({ port: Number(m[1]), log: buf })
      }
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`gateway exited ${code} before listen. stderr:\n${buf}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
    }
    child.stderr.on('data', onData)
    child.once('exit', onExit)
  })
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const dir = mkdtempSync(join(tmpdir(), 'cnr-http-e2e-'))
const docsDir = join(dir, 'docs')
mkdirSync(docsDir)
writeFileSync(join(docsDir, 'note.md'), `contact ${EMAIL} about the invoice\n`)
const keys = writeKeyPairFiles(join(dir, 'audit-ed25519'), 'cnr-http-e2e')
const receipts = join(dir, 'receipts.jsonl')
const audit = join(dir, 'audit.jsonl')
const tokensFile = join(dir, 'conarium.tokens.json')
writeFileSync(tokensFile, JSON.stringify({
  tokens: [{ sha256: sha256(PERSON), id: 'emekcan' }],
}) + '\n')
const configPath = join(dir, 'conarium.config.json')
writeFileSync(configPath, JSON.stringify({
  serverName: 'Conarium-e2e',
  consumer: 'e2e',
  connectors: [{
    type: 'docs',
    name: 'docs',
    description: 'e2e fixture',
    config: { path: docsDir },
  }],
  policy: {
    allowConnectors: ['docs'],
    allowTables: ['docs.note_md'],
    maskColumns: [],
    maxRows: 50,
  },
  audit: {
    sink: audit,
    failClosed: true,
    receiptSink: receipts,
  },
}, null, 2))

assert.ok(existsSync(httpJs), 'dist/http.js missing — test:checks runs build first')

const child = spawn(process.execPath, [httpJs, '--config', configPath], {
  cwd: dir,
  env: {
    ...process.env,
    CONARIUM_MCP_TOKEN: SHARED,
    CONARIUM_MCP_HOST: '127.0.0.1',
    CONARIUM_MCP_PORT: '0',
    CONARIUM_MCP_RATE_PER_MIN: '12',
    CONARIUM_TOKENS_FILE: tokensFile,
    CONARIUM_AUDIT_SIGNING_KEY: keys.privatePath,
    CONARIUM_AUDIT_TRUST_PUBKEYS: keys.publicPath,
    CONARIUM_NO_UPDATE_CHECK: '1',
    CONARIUM_AUDIT_UNSIGNED: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let url = ''
let produced = { 401: false, 403: false, 404: false, 429: false, 400: false, 500: false }

try {
  const ready = await waitReady(child)
  url = `http://127.0.0.1:${ready.port}/mcp`

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'conarium-http-e2e', version: '0.0.0' },
    },
  }

  let sessionId = ''

  await check('initialize returns Mcp-Session-Id and SSE event: message', async () => {
    const { res, text, ctype, sessionId: sid } = await rpc(url, { token: SHARED, payload: initialize })
    assert.equal(res.status, 200, text.slice(0, 300))
    assert.match(ctype, /text\/event-stream/, `content-type was ${ctype}`)
    assert.ok(sid && sid.length > 8, `missing Mcp-Session-Id (got ${sid})`)
    const frames = parseSseFrames(text)
    assert.ok(frames.length >= 1, 'no SSE frames')
    assert.equal(frames[0].event, 'message')
    assert.equal(frames[0].data.jsonrpc, '2.0')
    assert.ok(frames[0].data.result, `initialize result missing: ${JSON.stringify(frames[0].data)}`)
    sessionId = sid
  })

  await check('tools/list over the session returns query/search/list_tables', async () => {
    const { res, text, ctype } = await rpc(url, {
      token: SHARED,
      sessionId,
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    assert.equal(res.status, 200, text.slice(0, 300))
    assert.match(ctype, /text\/event-stream/)
    const msg = rpcFromSse(text)
    const names = (msg.result?.tools || []).map((t) => t.name)
    assert.ok(names.includes('list_tables'), `tools=${names.join(',')}`)
    assert.ok(names.includes('search'), `tools=${names.join(',')}`)
  })

  await check('tools/call search masks PII; receipt file grows 0 → 1; verify EXIT 0', async () => {
    assert.equal(countLines(receipts), 0, 'receipts must start empty')
    const { res, text } = await rpc(url, {
      token: SHARED,
      sessionId,
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'alice', connector: 'docs' } },
      },
    })
    assert.equal(res.status, 200, text.slice(0, 400))
    const msg = rpcFromSse(text)
    const blob = JSON.stringify(msg)
    assert.ok(!blob.includes(EMAIL), `email leaked: ${blob.slice(0, 400)}`)
    assert.ok(blob.includes('[MASKED_PII]'), `expected [MASKED_PII] in ${blob.slice(0, 400)}`)
    assert.equal(countLines(receipts), 1, `receipts grew to ${countLines(receipts)}`)
    const v = spawnSync(process.execPath, [verifyJs, receipts, '--pubkey', keys.publicPath], {
      encoding: 'utf8',
    })
    assert.equal(v.status, 0, `verify exit ${v.status}\n${v.stdout}\n${v.stderr}`)
    assert.match(String(v.stdout || v.stderr || ''), /verified/)
  })

  await check('unknown Mcp-Session-Id → HTTP 404 + application/json + JSON-RPC -32004', async () => {
    const { res, text, ctype } = await rpc(url, {
      token: SHARED,
      sessionId: '00000000-0000-0000-0000-000000000000',
      payload: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
      expectStatus: 404,
    })
    assert.match(ctype, /application\/json/)
    const body = JSON.parse(text)
    assert.equal(body.jsonrpc, '2.0')
    assert.equal(body.error.code, -32004)
    produced[404] = true
  })

  await check('401 unauthorized is application/json JSON-RPC', async () => {
    const { res, text, ctype } = await rpc(url, {
      token: 'totally-invalid-token-xxxxxxxxxxxx',
      payload: initialize,
      expectStatus: 401,
    })
    assert.match(ctype, /application\/json/)
    assert.equal(JSON.parse(text).jsonrpc, '2.0')
    produced[401] = true
  })

  await check('403 session owner mismatch is application/json JSON-RPC', async () => {
    const opened = await rpc(url, { token: PERSON, payload: initialize })
    assert.ok(opened.sessionId)
    const { res, text, ctype } = await rpc(url, {
      token: SHARED,
      sessionId: opened.sessionId,
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      expectStatus: 403,
    })
    assert.match(ctype, /application\/json/)
    assert.equal(JSON.parse(text).jsonrpc, '2.0')
    produced[403] = true
  })

  await check('400 expected initialize is application/json JSON-RPC', async () => {
    const { ctype, text } = await rpc(url, {
      token: SHARED,
      payload: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      expectStatus: 400,
    })
    assert.match(ctype, /application\/json/)
    assert.equal(JSON.parse(text).jsonrpc, '2.0')
    produced[400] = true
  })

  await check('500 invalid JSON body is application/json JSON-RPC', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${SHARED}`,
      },
      body: '{not-json',
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    const ctype = res.headers.get('content-type') || ''
    assert.equal(res.status, 500, text.slice(0, 200))
    assert.match(ctype, /application\/json/)
    assert.equal(JSON.parse(text).jsonrpc, '2.0')
    produced[500] = true
  })

  await check('429 rate limit is application/json JSON-RPC', async () => {
    let hit = null
    for (let i = 0; i < 20; i++) {
      const r = await rpc(url, {
        token: SHARED,
        sessionId,
        payload: { jsonrpc: '2.0', id: 100 + i, method: 'tools/list', params: {} },
      })
      if (r.res.status === 429) {
        hit = r
        break
      }
    }
    assert.ok(hit, 'did not produce 429 in 20 authenticated requests (rate=12/min)')
    assert.match(hit.ctype, /application\/json/)
    assert.equal(JSON.parse(hit.text).jsonrpc, '2.0')
    produced[429] = true
  })
} finally {
  if (!child.killed) child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    setTimeout(resolve, 2000)
  })
  rmSync(dir, { recursive: true, force: true })
}

for (const row of results) {
  if (row[0] === 'PASS') console.log(`PASS  ::  ${row[1]}`)
  else console.error(`FAIL  ::  ${row[1]}  — ${row[2]}`)
}

const missing = Object.entries(produced).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  console.log(`status codes not produced: ${missing.join(', ')}`)
}

console.log(`\nSummary: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
