/**
 * /handoff nonce → session cookie. The long-lived token never appears in the URL.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createConsoleApp } from '../dist/console.js'
import { createHandoffStore, createSessionStore } from '../dist/console-handoff.js'

function request(port, method, url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.end()
  })
}

const dir = mkdtempSync(path.join(tmpdir(), 'cnr-ho-'))
process.env.CONARIUM_AUDIT_UNSIGNED = '1'
process.env.CONARIUM_CONSOLE_TOKEN = 'long-lived-console-token-24ch'
process.env.CONARIUM_CONSOLE_CSRF_TOKEN = 'csrf-separate'

const handoff = createHandoffStore()
const sessions = createSessionStore()
const app = createConsoleApp({
  configFile: path.join(dir, 'c.json'),
  auditFile: path.join(dir, 'a.jsonl'),
  handoff,
  sessions,
})
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const port = server.address().port

const n = handoff.issue()
const first = await request(port, 'GET', `/handoff?n=${encodeURIComponent(n)}`)
assert.equal(first.status, 302)
assert.equal(first.headers.location, '/')
const setCookie = first.headers['set-cookie']
const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
assert.ok(cookies.some((c) => c.startsWith('conarium_console_sess=') && /HttpOnly/i.test(c)))
assert.ok(cookies.some((c) => c.startsWith('conarium_console_csrf=')))
assert.ok(!first.headers.location.includes('token='))
assert.ok(!JSON.stringify(first.headers).includes('long-lived-console-token'))

const second = await request(port, 'GET', `/handoff?n=${encodeURIComponent(n)}`)
assert.equal(second.status, 403)

const sess = cookies.find((c) => c.startsWith('conarium_console_sess=')).split(';')[0]
const csrf = cookies.find((c) => c.startsWith('conarium_console_csrf=')).split(';')[0].split('=')[1]
const ok = await request(port, 'GET', '/api/config', { cookie: sess })
assert.equal(ok.status, 200)

const noCsrf = await new Promise((resolve) => {
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/config',
      headers: { cookie: sess, 'content-type': 'application/json', 'content-length': 2 },
    },
    (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    },
  )
  req.end('{}')
})
assert.equal(noCsrf.status, 403)

const withCsrf = await request(port, 'GET', '/api/presence', { cookie: sess })
assert.equal(withCsrf.status, 204)

await new Promise((r) => server.close(r))
console.log('PASS  ::  handoff nonce is one-time, sets HttpOnly session, CSRF still required')
process.exit(0)
