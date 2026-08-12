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
import { RateLimiter, clientKey } from './rate_limit.js'
import { loadTokenStore, resolveActor } from './tokens.js'

const PORT = Number(process.env.CONARIUM_MCP_PORT || 8791)
const HOST = process.env.CONARIUM_MCP_HOST || '127.0.0.1'
const TOKEN = process.env.CONARIUM_MCP_TOKEN || ''
const RATE_PER_MIN = Number(process.env.CONARIUM_MCP_RATE_PER_MIN || 0)
// Bir kez yuklenir; dosya yoksa null = kisi bazli kimlik kapali (davranis birebir eski).
const TOKEN_STORE = loadTokenStore()

function tokenOk(supplied: string): boolean {
  if (!supplied) return false
  // sha256 both sides: equal-length buffers → timingSafeEqual güvenli
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(TOKEN).digest()
  return timingSafeEqual(a, b)
}

/** Oturumun sahibi = onu açan kimlik bilgisinin karması. Ham token asla saklanmaz. */
export function ownerKey(supplied: string): Buffer {
  return createHash('sha256').update(supplied).digest()
}

/** Sabit zamanlı karşılaştırma — iki taraf da sha256, uzunluklar eşit. */
export function sessionOwnerMatches(owner: Buffer, supplied: string): boolean {
  return timingSafeEqual(owner, ownerKey(supplied))
}

/**
 * Transport + onu açan kimlik. Kimliği transport'la BİRLİKTE tutuyoruz, çünkü
 * `buildServer(deps, kisi)` oturum başına bir kez çağrılır: o andan sonra gelen
 * her istek, o Server'ın kimliğiyle çalışır ve makbuzu o ad altında yazar.
 */
export interface SessionEntry {
  transport: StreamableHTTPServerTransport
  owner: Buffer
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
 * İstek işleyicisi — main()'den ayrı tutuluyor çünkü oturum sahipliği kuralının
 * test edilebilir olması gerekiyor: bir devralma denemesi düzeltmeden önce
 * kırmızı yanmadan "kapatıldı" denemez.
 */
export function createHandler(
  deps: Awaited<ReturnType<typeof bootDeps>>,
  transports: Map<string, SessionEntry>,
  limiter: RateLimiter,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
      // Kimlik: kişiye özel token eşleşirse o kişi, yoksa paylaşılan token.
      // İkisi de tutmuyorsa 401 — kişi bazlı kimlik yetkiyi GENİŞLETMEZ, sadece
      // kimin geçtiğini adlandırır. Eşleşmeyen token hâlâ kapıda kalır.
      const kisi = resolveActor(supplied, TOKEN_STORE, deps.config.consumer ?? 'unknown')
      if (!kisi.isUser && !tokenOk(supplied)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
        return
      }

      // Limit AFTER auth: an unauthorized flood must not burn a real client's budget.
      const client = clientKey(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? undefined)
      if (!limiter.take(client)) {
        res
          .writeHead(429, { 'content-type': 'text/plain', 'retry-after': String(limiter.retryAfter(client)) })
          .end('rate limited')
        return
      }

      const sessionId = String(req.headers['mcp-session-id'] || '') || undefined
      const existing = sessionId ? transports.get(sessionId) : undefined

      if (existing) {
        // Kapının kendisi: oturum, onu açan kimlik bilgisine aittir. Geçerli bir
        // token taşımak konuşma hakkı vermez — AYNI token olmalı. Bu kontrol
        // olmadan, kişisel token'la açılmış bir oturumun id'sini ele geçiren
        // paylaşılan-token sahibi, o kişinin profil/maskeleme bağlamıyla çalışır
        // ve o andan sonraki her makbuz yanlış kişiyi adlandırır.
        if (!sessionOwnerMatches(existing.owner, supplied)) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('session owner mismatch')
          return
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await existing.transport.handleRequest(req, res, body)
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
      const owner = ownerKey(supplied)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { transports.set(id, { transport, owner }) },
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      const server = buildServer(deps, kisi)   // oturum başına Server + oturumun kimligi; connectors/governance/audit ORTAK
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[conarium-http] istek hatası:', (err as Error).message)
      try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error') } catch { /* */ }
    }
  }
}

async function main() {
  if (!TOKEN || TOKEN.length < 24) {
    console.error('[conarium-http] CONARIUM_MCP_TOKEN eksik ya da <24 karakter — fail-closed, başlamıyorum.')
    process.exit(1)
  }

  const config = loadConfig()
  const deps = await bootDeps(config)
  const transports = new Map<string, SessionEntry>()
  const limiter = new RateLimiter({ perWindow: RATE_PER_MIN })
  const sweepTimer = setInterval(() => limiter.sweep(), 5 * 60_000)
  sweepTimer.unref()

  const httpServer = createHttpServer(createHandler(deps, transports, limiter))

  httpServer.listen(PORT, HOST, () => {
    const rate = limiter.enabled ? `${RATE_PER_MIN}/dk` : 'KAPALI'
    console.error(
      `[conarium-http] remote MCP hazır — http://${HOST}:${PORT} (token: SET, ${deps.connectors.length} connector, rate-limit: ${rate})`
    )
  })

  process.on('SIGINT', async () => {
    for (const t of transports.values()) await t.transport.close().catch(() => {})
    for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
    process.exit(0)
  })
}

/**
 * main() yalnızca dosya DOĞRUDAN çalıştırıldığında koşar.
 *
 * Modül seviyesinde koşulduğu sürece bu dosyayı içe aktarmak sunucuyu ayağa
 * kaldırır ya da config bulamayıp `process.exit(1)` ile çağıranı öldürür —
 * yani oturum sahipliği gibi bir kuralın testi hiç yazılamazdı. Test edilemeyen
 * güvenlik kuralı, olmayan güvenlik kuralıdır.
 *
 * Tespit başarısız olursa ESKİ davranışa düşeriz (çalıştır): bir sunucunun
 * sessizce başlamaması, bir testin gürültülü patlamasından pahalıdır.
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
