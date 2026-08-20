/**
 * The public /proof endpoint must not answer with the reason it failed.
 *
 * CodeQL found this on 21 August 2026 (js/stack-trace-exposure): the 503 path
 * put `err.message` in the response body. The failures that reach that path are
 * a missing signing key and an unreadable chain, and their messages carry file
 * system paths. The directory had never been scanned because it lived outside
 * the repository — the alert appeared the day it was added, not the day it was
 * written.
 *
 * Red first: restore `err.message` in the 503 body and this check fails.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const routeUrl = pathToFileURL(
  join(process.cwd(), 'deploy', 'hetzner', 'proof-service', 'deploy', 'hetzner-proof-route.mjs'),
).href

// The proof module loads the receipt view from the core package; this repository
// is that package, so point it at itself rather than at an installed copy.
process.env.CONARIUM_ROOT = process.env.CONARIUM_ROOT || process.cwd()

// No key, no chain: the proof body cannot be built, so the handler takes the
// failure path this check is about.
delete process.env.CONARIUM_PROOF_CHAIN
process.env.CONARIUM_PROOF_KEY = join(process.cwd(), 'no', 'such', 'signing-key.pem')
process.env.CONARIUM_PROOF_ALLOW_EPHEMERAL = '0'

const { handleProofRequest, resetProofCache } = await import(routeUrl)
resetProofCache()

function fakeRes() {
  const out = { status: 0, headers: {}, body: '', headersSent: false, destroyed: false }
  const res = {
    get headersSent() {
      return out.headersSent
    },
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
      out.headersSent = true
      return res
    },
    end(chunk) {
      out.body = chunk == null ? '' : String(chunk)
      return res
    },
    destroy() {
      out.destroyed = true
    },
  }
  return { res, out }
}

const { res, out } = fakeRes()
const req = {
  method: 'GET',
  url: '/proof',
  headers: { host: 'demo.example', accept: 'application/json' },
  socket: { remoteAddress: '203.0.113.9' },
}
await handleProofRequest(req, res)

assert.equal(out.status, 503, `expected the failure path, got ${out.status} with body ${out.body}`)

// Whatever the reason was, the visitor gets one sentence that names nothing.
assert.deepEqual(JSON.parse(out.body), { error: 'proof unavailable' }, `503 body leaks the reason: ${out.body}`)

const forbidden = [
  ['ENOENT', /ENOENT/],
  ['no such file', /no such file/i],
  ['a path separator', /[\/](?:[A-Za-z0-9_.-]+[\/])+/],
  ['a drive letter', /[A-Za-z]:[\/]/],
  ['a stack frame', /\bat .+:\d+:\d+/],
]
for (const [what, pattern] of forbidden) {
  assert.ok(!pattern.test(out.body), `503 body exposes ${what}: ${out.body}`)
}

console.log('ok: /proof failure body names nothing — 503 {"error":"proof unavailable"}')
