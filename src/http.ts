#!/usr/bin/env node
/**
 * Conarium remote entrypoint — Streamable HTTP MCP (claude.ai / mobile / any remote client).
 *
 * Security model:
 *  - CONARIUM_MCP_TOKEN (>=24 chars) is REQUIRED; server refuses to boot without it (fail-closed).
 *  - Token is accepted either as capability URL (/t/<token>/mcp — claude.ai custom connector UI
 *    has no header field) or as Authorization: Bearer <token>. Comparison is timing-safe.
 *  - Bind 127.0.0.1 by default: TLS termination is a reverse proxy's job (Caddy/Let's Encrypt).
 *  - Same governance/audit pipeline as stdio mode — allowlist, deny, mask, row caps unchanged.
 *  - CONARIUM_MCP_RATE_PER_MIN caps requests per client per minute (0 = off). Public demo
 *    deployments hand the URL to strangers and must set it.
 *
 * Session model: canonical SDK pattern — an initialize POST opens a session (own Server+transport),
 * subsequent requests route by Mcp-Session-Id header; DELETE closes the session.
 *
 * A session is bound to the credential that OPENED it. Carrying a valid token is not
 * enough to speak into an existing session — it must be the SAME token. Without that
 * binding, anyone holding any valid token could take over a session opened with a
 * per-user credential by presenting its session id, and every receipt written from
 * that point on would name the wrong person. The session id travels in a plain header
 * and lands in proxy logs, so it is routing information, not a secret, and must never
 * be the only thing standing between two identities.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig, bootDeps, buildServer } from './server.js'
import { resolveHttpRatePerMin } from './config.js'
import { RateLimiter, clientKey } from './rate_limit.js'
import { existsSync, readFileSync } from 'node:fs'
import { loadTokenStore, resolveActor } from './tokens.js'
import { announceUpdate } from './update-check.js'

const PORT = Number(process.env.CONARIUM_MCP_PORT || 8791)
const HOST = process.env.CONARIUM_MCP_HOST || '127.0.0.1'
const TOKEN = process.env.CONARIUM_MCP_TOKEN || ''
// Loaded once; if the file is missing, null = per-person identity is off (behavior identical to before).
/**
 * Staleness is decided by the file's CONTENT, not its mtime.
 *
 * mtime has filesystem-dependent resolution, so two writes inside one tick are
 * indistinguishable. For a token file that is not a cosmetic problem: revoke a
 * token in the same tick as an earlier edit and the revocation is silently
 * ignored — the token keeps working until something else touches the file.
 * The file is a small map by construction; hashing it on read costs less than
 * being wrong about who is allowed in.
 */
const TOKEN_STORE_REF: { store: ReturnType<typeof loadTokenStore>; fingerprint: string; path: string } = {
  store: loadTokenStore(),
  fingerprint: '',
  path: process.env.CONARIUM_TOKENS_FILE || 'conarium.tokens.json',
}

function tokenFileFingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

try {
  if (existsSync(TOKEN_STORE_REF.path)) {
    TOKEN_STORE_REF.fingerprint = tokenFileFingerprint(TOKEN_STORE_REF.path)
  }
} catch { /* first load already happened */ }

export function currentTokenStore(): ReturnType<typeof loadTokenStore> {
  const path = process.env.CONARIUM_TOKENS_FILE || TOKEN_STORE_REF.path
  try {
    if (!existsSync(path)) {
      TOKEN_STORE_REF.store = null
      TOKEN_STORE_REF.fingerprint = ''
      TOKEN_STORE_REF.path = path
      return null
    }
    const fingerprint = tokenFileFingerprint(path)
    if (path === TOKEN_STORE_REF.path && fingerprint === TOKEN_STORE_REF.fingerprint) {
      return TOKEN_STORE_REF.store
    }
    const next = loadTokenStore(path)
    TOKEN_STORE_REF.store = next
    TOKEN_STORE_REF.fingerprint = fingerprint
    TOKEN_STORE_REF.path = path
    return next
  } catch (err) {
    console.error(
      '[conarium-http] token store reload failed; keeping previous store:',
      err instanceof Error ? err.message : err,
    )
    return TOKEN_STORE_REF.store
  }
}

function tokenOk(supplied: string): boolean {
  if (!supplied) return false
  // sha256 both sides: equal-length buffers → timingSafeEqual is safe
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(TOKEN).digest()
  return timingSafeEqual(a, b)
}

/** Session owner = hash of the credential that opened it. The raw token is never stored. */
export function ownerKey(supplied: string): Buffer {
  return createHash('sha256').update(supplied).digest()
}

/** Constant-time comparison — both sides are sha256, lengths are equal. */
export function sessionOwnerMatches(owner: Buffer, supplied: string): boolean {
  return timingSafeEqual(owner, ownerKey(supplied))
}

/**
 * Transport + the identity that opened it. We keep the identity WITH the
 * transport because `buildServer(deps, kisi)` is called once per session:
 * every request after that runs under that Server's identity and writes
 * the receipt under that name.
 */
export interface SessionEntry {
  transport: StreamableHTTPServerTransport
  owner: Buffer
  lastActive?: number
}

export interface HttpHandlerOpts {
  now?: () => number
  idleMs?: number
  maxSessions?: number
}

export function resolveSessionIdleMs(): number {
  const raw = process.env.CONARIUM_SESSION_IDLE_MS
  if (raw === undefined || raw === '') return 30 * 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60_000
}

export function resolveMaxSessions(): number {
  const raw = process.env.CONARIUM_MAX_SESSIONS
  if (raw === undefined || raw === '') return 100
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 100
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) { resolvePromise(undefined); return }
      try { resolvePromise(JSON.parse(raw)) } catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

/**
 * Request handler — kept separate from main() because the session-ownership
 * rule must be testable: a takeover attempt cannot be called "closed" until
 * it has gone red before the fix.
 */
/**
 * Error bodies MUST be JSON-RPC.
 *
 * Happened in production on 2026-08-13: the gateway was restarted, the client
 * arrived with the old `Mcp-Session-Id` it still held, the server returned
 * `400 expected initialize` + `text/plain`. The client-side proxy could not
 * parse that and told the user "Invalid content from server" — so the real
 * cause (session dropped, restart) NEVER reached the user. A plain-text
 * error is an undiagnosable error.
 */
function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

export function createHandler(
  deps: Awaited<ReturnType<typeof bootDeps>>,
  transports: Map<string, SessionEntry>,
  limiter: RateLimiter,
  opts: HttpHandlerOpts = {},
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')

      // Health endpoint without a TLS proxy (does not ask for a token, returns no data)
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }

      // Public demo has no OAuth. MCP clients probe RFC 9728 / RFC 8414
      // paths and treat 302+HTML as metadata, then fall into Dynamic Client
      // Registration and die. 404 is the honest answer. Caddy must also
      // 404 these before its catch-all redir — this is defense in depth
      // if the proxy ever forwards /.well-known/* here.
      if (url.pathname === '/.well-known' || url.pathname.startsWith('/.well-known/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }

      // Path: /t/<token>/mcp (capability URL) or /mcp + Authorization: Bearer
      const pathMatch = url.pathname.match(/^\/t\/([^/]+)\/mcp$/)
      const isPlainMcp = url.pathname === '/mcp'
      if (!pathMatch && !isPlainMcp) {
        sendRpcError(res, 404, -32600, 'not found — the MCP endpoint is /mcp')
        return
      }
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const supplied = pathMatch ? decodeURIComponent(pathMatch[1]) : bearer
      // Identity: if a per-person token matches, that person; otherwise the
      // shared token. If neither holds, 401 — per-person identity does NOT
      // widen authorization, it only names who got through. A non-matching
      // token still stays at the door.
      const kisi = resolveActor(supplied, currentTokenStore(), deps.config.consumer ?? 'unknown')
      if (!kisi.isUser && !tokenOk(supplied)) {
        sendRpcError(res, 401, -32001, 'unauthorized')
        return
      }

      // Limit AFTER auth: an unauthorized flood must not burn a real client's budget.
      const client = clientKey(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? undefined)
      if (!limiter.take(client)) {
        sendRpcError(res, 429, -32002, 'rate limited', {
          'retry-after': String(limiter.retryAfter(client)),
        })
        return
      }

      const sessionId = String(req.headers['mcp-session-id'] || '') || undefined
      const existing = sessionId ? transports.get(sessionId) : undefined

      if (existing) {
        // The door itself: the session belongs to the credential that opened
        // it. Carrying a valid token does not grant the right to speak — it
        // must be the SAME token. Without this check, a shared-token holder
        // who captured the id of a session opened with a personal token would
        // run in that person's profile/masking context, and every receipt
        // from that point on would name the wrong person.
        if (!sessionOwnerMatches(existing.owner, supplied)) {
          sendRpcError(res, 403, -32003, 'session owner mismatch')
          return
        }
        const now = opts.now?.() ?? Date.now()
        const idleMs = opts.idleMs ?? resolveSessionIdleMs()
        if (idleMs > 0 && existing.lastActive != null && now - existing.lastActive > idleMs) {
          if (sessionId) transports.delete(sessionId)
          sendRpcError(res, 404, -32004, 'session not found — send a new initialize request')
          return
        }
        existing.lastActive = now
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await existing.transport.handleRequest(req, res, body)
        return
      }

      // A session id ARRIVED but is not on the server: restarted gateway, or
      // an expired session. The spec says 404 for this — what the client must
      // do is open a new initialize. 400 means "the request is malformed";
      // the client does not treat that as a recovery signal and the
      // connection dies permanently. That is exactly what happened in
      // production: after the 03:38 restart the connector never opened again.
      if (sessionId) {
        sendRpcError(res, 404, -32004, 'session not found — send a new initialize request')
        return
      }

      // New session: only an initialize POST opens one
      if (req.method !== 'POST') {
        sendRpcError(res, 400, -32600, 'no session — open one with an initialize POST')
        return
      }
      const maxSessions = opts.maxSessions ?? resolveMaxSessions()
      if (maxSessions > 0 && transports.size >= maxSessions) {
        sendRpcError(res, 429, -32005, 'too many sessions')
        return
      }
      const body = await readBody(req)
      if (!isInitializeRequest(body)) {
        sendRpcError(res, 400, -32600, 'expected initialize')
        return
      }
      const owner = ownerKey(supplied)
      const openedAt = opts.now?.() ?? Date.now()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, { transport, owner, lastActive: openedAt })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      const server = buildServer(deps, kisi)   // one Server per session + the session's identity; connectors/governance/audit are SHARED
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[conarium-http] request error:', (err as Error).message)
      try { if (!res.headersSent) sendRpcError(res, 500, -32603, 'internal error') } catch { /* */ }
    }
  }
}

async function main() {
  if (!TOKEN || TOKEN.length < 24) {
    console.error('[conarium-http] CONARIUM_MCP_TOKEN missing or shorter than 24 characters — fail-closed, not starting.')
    process.exit(1)
  }

  const config = loadConfig()
  const ratePerMin = resolveHttpRatePerMin(config)
  const deps = await bootDeps(config)
  const transports = new Map<string, SessionEntry>()
  const limiter = new RateLimiter({ perWindow: ratePerMin })
  const idleMs = resolveSessionIdleMs()
  const sweepTimer = setInterval(() => limiter.sweep(), 5 * 60_000)
  sweepTimer.unref()
  if (idleMs > 0) {
    const idleSweep = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of transports) {
        if (entry.lastActive != null && now - entry.lastActive > idleMs) {
          transports.delete(id)
          void entry.transport.close().catch(() => {})
        }
      }
    }, Math.min(idleMs, 60_000))
    idleSweep.unref()
  }

  const httpServer = createHttpServer(createHandler(deps, transports, limiter))

  httpServer.listen(PORT, HOST, () => {
    const addr = httpServer.address()
    const bound = typeof addr === 'object' && addr !== null ? addr.port : PORT
    const rate = limiter.enabled ? `${ratePerMin}/min` : 'OFF'
    console.error(
      `[conarium-http] remote MCP ready — http://${HOST}:${bound} (token: SET, ${deps.connectors.length} connector, rate-limit: ${rate})`
    )
    // A remote gateway is the one nobody looks at for weeks. One stderr line at
    // start is the only place a stale build gets announced to its operator.
    announceUpdate()
  })

  process.on('SIGINT', async () => {
    for (const t of transports.values()) await t.transport.close().catch(() => {})
    for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
    deps.audit.close()
    process.exit(0)
  })
}

/**
 * main() runs only when the file is executed DIRECTLY.
 *
 * As long as it ran at module level, importing this file would start the
 * server or fail to find config and kill the caller with `process.exit(1)` —
 * so a test of a rule like session ownership could never be written. An
 * untestable security rule is a security rule that does not exist.
 *
 * If detection fails we fall back to the OLD behavior (run): a server that
 * silently fails to start is more expensive than a test blowing up loudly.
 */
const dogrudanCalistirildi = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return true
  }
})()

if (dogrudanCalistirildi) {
  main().catch(err => {
    console.error('[conarium-http] Fatal:', err)
    process.exit(1)
  })
}
