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
 *
 * Session model: canonical SDK pattern — an initialize POST opens a session (own Server+transport),
 * subsequent requests route by Mcp-Session-Id header; DELETE closes the session.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig, bootDeps, buildServer } from './server.js'

const PORT = Number(process.env.CONARIUM_MCP_PORT || 8791)
const HOST = process.env.CONARIUM_MCP_HOST || '127.0.0.1'
const TOKEN = process.env.CONARIUM_MCP_TOKEN || ''

function tokenOk(supplied: string): boolean {
  if (!supplied) return false
  // sha256 both sides: equal-length buffers → timingSafeEqual güvenli
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(TOKEN).digest()
  return timingSafeEqual(a, b)
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

async function main() {
  if (!TOKEN || TOKEN.length < 24) {
    console.error('[conarium-http] CONARIUM_MCP_TOKEN eksik ya da <24 karakter — fail-closed, başlamıyorum.')
    process.exit(1)
  }

  const config = loadConfig()
  const deps = await bootDeps(config)
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')

      // TLS proxy'siz sağlık ucu (token istemez, veri dönmez)
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }

      // Yol: /t/<token>/mcp (capability URL) ya da /mcp + Authorization: Bearer
      const pathMatch = url.pathname.match(/^\/t\/([^/]+)\/mcp$/)
      const isPlainMcp = url.pathname === '/mcp'
      if (!pathMatch && !isPlainMcp) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const supplied = pathMatch ? decodeURIComponent(pathMatch[1]) : bearer
      if (!tokenOk(supplied)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
        return
      }

      const sessionId = String(req.headers['mcp-session-id'] || '') || undefined
      const existing = sessionId ? transports.get(sessionId) : undefined

      if (existing) {
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await existing.handleRequest(req, res, body)
        return
      }

      // Yeni oturum: yalnız initialize POST açar
      if (req.method !== 'POST') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no session')
        return
      }
      const body = await readBody(req)
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('expected initialize')
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { transports.set(id, transport) },
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      const server = buildServer(deps)   // oturum başına Server; connectors/governance/audit ORTAK
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[conarium-http] istek hatası:', (err as Error).message)
      try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error') } catch { /* */ }
    }
  })

  httpServer.listen(PORT, HOST, () => {
    console.error(`[conarium-http] remote MCP hazır — http://${HOST}:${PORT} (token: SET, ${deps.connectors.length} connector)`)
  })

  process.on('SIGINT', async () => {
    for (const t of transports.values()) await t.close().catch(() => {})
    for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
    process.exit(0)
  })
}

main().catch(err => {
  console.error('[conarium-http] Fatal:', err)
  process.exit(1)
})
