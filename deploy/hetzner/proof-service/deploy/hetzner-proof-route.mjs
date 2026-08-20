#!/usr/bin/env node
/**
 * Hetzner conarium-demo GET /proof handler (port 8793).
 *
 * ⚠️ WRITE ONLY — DO NOT DEPLOY without patron approval + Claude GATE B.
 * Wire into the demo reverse-proxy stack when approved:
 *   node deploy/hetzner-proof-route.mjs
 *
 * Rate limit: 40/min. Cache: 60s in-process.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLiveProof, renderProofHtml, serializeProofJson, wantsProofHtml } from '../dist/proof.js'

const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The page reads the chain from CONARIUM_PROOF_CHAIN and nothing else
 * (`loadProofChain` in dist/proof.js). If this route fell back to the repo copy
 * when that env is unset, a misconfigured box would publish one head on the page
 * and hand out a chain with a different head. Same source or nothing.
 */
function proofChainPath() {
  return process.env.CONARIUM_PROOF_CHAIN?.trim() || null
}

function chainHeadOf(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return null
  try {
    return JSON.parse(lines[lines.length - 1])?.chain?.hash ?? null
  } catch {
    return null
  }
}

function proofPubkeyPath() {
  return process.env.CONARIUM_PROOF_PUBKEY?.trim() || join(DEPLOY_DIR, 'proof', 'key.pub.pem')
}

function servePublicFile(res, filePath, contentType, { publicKeyOnly = false } = {}) {
  if (!filePath || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  const body = readFileSync(filePath)
  const text = body.toString('utf8')
  if (publicKeyOnly) {
    if (!text.includes('BEGIN PUBLIC KEY') || /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refusing to serve a private key')
      return
    }
  }
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'public, max-age=60',
  })
  res.end(body)
}
// Engine version is resolved once, in dist/proof.js (resolveEngineVersion).
// Set CONARIUM_ROOT=/opt/conarium-mcp on the box. Do not hardcode a cut here.

const PORT = Number(process.env.CONARIUM_PROOF_PORT || 8793)
const HOST = process.env.CONARIUM_PROOF_HOST || '127.0.0.1'
const RATE_PER_MIN = 40
const CACHE_MS = 60_000

const buckets = new Map()
let cache = { at: 0, body: null }
let inflight = null

async function cachedProof() {
  const now = Date.now()
  if (cache.body && now - cache.at < CACHE_MS) return cache.body
  if (inflight) return inflight
  inflight = buildLiveProof()
    .then((body) => {
      cache = { at: Date.now(), body }
      return body
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function clientIp(req) {
  return (
    (req.headers['x-real-ip'] || '').toString().trim() ||
    (req.headers['x-forwarded-for'] || '').toString().split(',').pop()?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  )
}

function rateLimit(ip) {
  const now = Date.now()
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now - b.start >= 60_000) buckets.delete(k)
  }
  const b = buckets.get(ip)
  if (!b || now - b.start >= 60_000) {
    buckets.set(ip, { start: now, count: 1 })
    return true
  }
  b.count += 1
  return b.count <= RATE_PER_MIN
}

export async function handleProofRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'GET' && (url.pathname === '/proof' || url.pathname === '/proof/')) {
    if (!rateLimit(clientIp(req))) {
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'rate limit' }))
      return
    }
    try {
      const body = await cachedProof()
      const html = wantsProofHtml(String(req.headers.accept || ''), url.searchParams.get('format'))
      const headers = {
        'cache-control': 'public, max-age=60',
        vary: 'Accept',
      }
      if (html) {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
        res.end(renderProofHtml(body))
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
        res.end(serializeProofJson(body))
      }
    } catch (err) {
      // Fail-closed: missing signing key (no ephemeral unless explicitly allowed).
      // Only if nothing was sent yet — a throw from res.end() after a 200 would
      // otherwise become "headers already sent" and take the process with it.
      if (res.headersSent) {
        res.destroy()
        return
      }
      // The reason belongs in the operator's log, not in the response body. This
      // endpoint is public and the failures that reach here name paths and keys.
      console.error(`proof: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'proof unavailable' }))
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/proof/chain.jsonl') {
    // A visitor verifies this file against the head printed on the page. Hand it
    // over only while the two agree — the page body is cached for 60s, so the
    // stamper rewriting the chain underneath is a real window, not a theory.
    const chainPath = proofChainPath()
    if (!chainPath || !existsSync(chainPath)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    let published = null
    try {
      published = (await cachedProof()).chain?.head ?? null
    } catch {
      published = null
    }
    const served = chainHeadOf(readFileSync(chainPath, 'utf8'))
    if (!published || served !== published) {
      res
        .writeHead(503, { 'content-type': 'text/plain' })
        .end('chain head does not match the published proof — refusing to serve a contradicting chain')
      return
    }
    servePublicFile(res, chainPath, 'application/jsonl; charset=utf-8')
    return
  }
  // conarium-verify --anchor-check resolves this next to the chain and exits 14
  // when a receipt claims an anchor whose record is missing. Publishing the
  // chain without it hands the visitor a command that cannot succeed.
  if (req.method === 'GET' && url.pathname === '/proof/chain.jsonl.anchors.jsonl') {
    const chainPath = proofChainPath()
    servePublicFile(res, chainPath ? `${chainPath}.anchors.jsonl` : null, 'application/jsonl; charset=utf-8')
    return
  }
  if (req.method === 'GET' && url.pathname === '/proof/key.pem') {
    servePublicFile(res, proofPubkeyPath(), 'application/x-pem-file; charset=utf-8', { publicKeyOnly: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/proof/key.pem.keyid') {
    servePublicFile(res, `${proofPubkeyPath()}.keyid`, 'text/plain; charset=utf-8')
    return
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  res.writeHead(404).end('not found')
}

export function resetProofCache() {
  cache = { at: 0, body: null }
  inflight = null
}

// The handler became async when masking moved to a dynamic import. A rejection
// from it — a malformed request target, or the error path failing after headers
// went out — is an unhandled rejection, and Node ends the process on those. The
// proof page has to fail as a request, not as a service.
const server = createServer((req, res) => {
  handleProofRequest(req, res).catch((err) => {
    console.error('[hetzner-proof] request failed:', err)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'internal error' }))
  })
})

if (process.argv[1] && process.argv[1].includes('hetzner-proof-route')) {
  server.listen(PORT, HOST, () => {
    console.error(`[hetzner-proof] listening on http://${HOST}:${PORT}/proof (NOT for unapproved deploy)`)
  })
}

export { server, buildLiveProof }
