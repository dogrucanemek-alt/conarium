/**
 * Console receipt tab: auth on every path, no sample receipts, broken chain
 * is visible, private key never leaves the process.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createConsoleApp } from '../dist/console.js'
import { buildReceipt, RECEIPT_GENESIS_HASH } from '../dist/receipt.js'

const prevUnsigned = process.env.CONARIUM_AUDIT_UNSIGNED
process.env.CONARIUM_AUDIT_UNSIGNED = '1'
process.env.CONARIUM_CONSOLE_TOKEN = 'receipt-tab-token-24ch'
process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf-receipt'
delete process.env.CONARIUM_AUDIT_SIGNING_KEY

function request(port, method, url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(body) } catch { json = null }
        resolve({ status: res.statusCode, headers: res.headers, body, json })
      })
    })
    req.end()
  })
}

function receipt(seq, prevHash, id) {
  return buildReceipt(
    {
      id,
      ts: `2026-08-14T11:00:0${seq}.000Z`,
      period: { start: '2026-08-14T11:00:00.000Z', end: '2026-08-14T11:00:01.000Z' },
      actor: { id: 'console-test' },
      request: { tool: 'query', target: 'demo-db', argsHash: 'sha256:ab' },
      dataRefs: [],
      policy: { id: 'p', version: '1', decision: 'allow', rulesApplied: [] },
      flags: [],
      masking: { maskedCount: 1, byClass: {}, rowsReturned: 2, rowCapApplied: false },
      outcome: { status: 'complete', denied: false },
    },
    { seq, prevHash },
    null,
  )
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnr-rcpt-'))
const sink = path.join(dir, 'conarium-receipts.jsonl')
const a = receipt(1, RECEIPT_GENESIS_HASH, 'rec-aaa')
const b = receipt(2, a.chain.hash, 'rec-bbb')
fs.writeFileSync(sink, JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n')
fs.writeFileSync(
  path.join(dir, 'c.json'),
  JSON.stringify({ policy: {}, audit: { sink: path.join(dir, 'audit.jsonl'), receiptSink: sink } }),
)

const app = createConsoleApp({
  configFile: path.join(dir, 'c.json'),
  auditFile: path.join(dir, 'audit.jsonl'),
})
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const port = server.address().port
const auth = { authorization: 'Bearer receipt-tab-token-24ch' }

const unauth = await request(port, 'GET', '/api/receipts')
assert.equal(unauth.status, 401)

const unauthOne = await request(port, 'GET', '/api/receipts/rec-aaa')
assert.equal(unauthOne.status, 401)

const unauthRaw = await request(port, 'GET', '/api/receipts/rec-aaa/raw')
assert.equal(unauthRaw.status, 401)

const list = await request(port, 'GET', '/api/receipts', auth)
assert.equal(list.status, 200)
assert.equal(list.json.items.length, 2)
assert.equal(list.json.items[0].id, 'rec-bbb', 'newest first')
assert.equal(list.json.chain.ok, true)
assert.equal(list.json.empty, null)
assert.ok(!JSON.stringify(list.json).includes('BEGIN PRIVATE'))

const one = await request(port, 'GET', '/api/receipts/rec-aaa', auth)
assert.equal(one.status, 200)
assert.equal(one.json.receipt.id, 'rec-aaa')
assert.ok(one.json.html.includes('Receipt rec-aaa'))
assert.ok(one.json.html.includes('Limitations'))
assert.ok(!one.json.html.includes('BEGIN PRIVATE'))
assert.ok(!JSON.stringify(one.json.receipt).includes('BEGIN PRIVATE'))

const raw = await request(port, 'GET', '/api/receipts/rec-aaa/raw', auth)
assert.equal(raw.status, 200)
assert.equal(raw.json.id, 'rec-aaa')
assert.match(raw.headers['content-disposition'] || '', /rec-aaa\.json/)

const missing = await request(port, 'GET', '/api/receipts/no-such', auth)
assert.equal(missing.status, 404)

await new Promise((r) => server.close(r))

const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnr-rcpt-brk-'))
const brokenSink = path.join(brokenDir, 'r.jsonl')
const brokenB = { ...b, id: 'rec-brk', chain: { ...b.chain, hash: 'sha256:deadbeef' } }
fs.writeFileSync(brokenSink, JSON.stringify(a) + '\n' + JSON.stringify(brokenB) + '\n')
fs.writeFileSync(
  path.join(brokenDir, 'c.json'),
  JSON.stringify({ policy: {}, audit: { receiptSink: brokenSink } }),
)
const app2 = createConsoleApp({
  configFile: path.join(brokenDir, 'c.json'),
  auditFile: path.join(brokenDir, 'a.jsonl'),
})
const server2 = app2.listen(0, '127.0.0.1')
await new Promise((r) => server2.once('listening', r))
const port2 = server2.address().port
const brokenList = await request(port2, 'GET', '/api/receipts', auth)
assert.equal(brokenList.status, 200)
assert.equal(brokenList.json.chain.ok, false)
assert.equal(brokenList.json.chain.brokenAt, 2)
assert.ok(brokenList.json.items.length >= 1)
const brokenHtml = await request(port2, 'GET', '/api/receipts/rec-aaa/html', auth)
assert.equal(brokenHtml.status, 200)
assert.ok(brokenHtml.body.includes('broken (row 2)'))
assert.ok(!brokenHtml.body.includes('chain intact'))
await new Promise((r) => server2.close(r))

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnr-rcpt-empty-'))
fs.writeFileSync(path.join(emptyDir, 'c.json'), JSON.stringify({ policy: {} }))
const app3 = createConsoleApp({
  configFile: path.join(emptyDir, 'c.json'),
  auditFile: path.join(emptyDir, 'a.jsonl'),
})
const server3 = app3.listen(0, '127.0.0.1')
await new Promise((r) => server3.once('listening', r))
const empty = await request(server3.address().port, 'GET', '/api/receipts', auth)
assert.equal(empty.status, 200)
assert.equal(empty.json.items.length, 0)
assert.match(empty.json.empty, /no receipts yet/)
assert.ok(!JSON.stringify(empty.json).includes('örnek'))
await new Promise((r) => server3.close(r))

if (prevUnsigned === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
else process.env.CONARIUM_AUDIT_UNSIGNED = prevUnsigned

console.log('PASS  ::  receipts tab is authenticated, lists newest first, shows a broken chain, invents nothing')
process.exit(0)
