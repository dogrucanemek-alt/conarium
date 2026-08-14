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
import { loadTokenStore, resolveActor } from './tokens.js'
import { announceUpdate } from './update-check.js'

const PORT = Number(process.env.CONARIUM_MCP_PORT || 8791)
const HOST = process.env.CONARIUM_MCP_HOST || '127.0.0.1'
const TOKEN = process.env.CONARIUM_MCP_TOKEN || ''
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
/**
 * Hata gövdeleri JSON-RPC olmak ZORUNDA.
 *
 * 2026-08-13'te canlıda yaşandı: geçit yeniden başlatıldı, istemci elindeki eski
 * `Mcp-Session-Id` ile geldi, sunucu `400 expected initialize` + `text/plain`
 * döndü. İstemci tarafındaki proxy bunu ayrıştıramadı ve kullanıcıya
 * "Invalid content from server" dedi — yani gerçek sebep (oturum düştü, yeniden
 * başlat) kullanıcıya HİÇ ulaşmadı. Düz metin hata, teşhis edilemeyen hata demek.
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
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')

      // TLS proxy'siz sağlık ucu (token istemez, veri dönmez)
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

      // Yol: /t/<token>/mcp (capability URL) ya da /mcp + Authorization: Bearer
      const pathMatch = url.pathname.match(/^\/t\/([^/]+)\/mcp$/)
      const isPlainMcp = url.pathname === '/mcp'
      if (!pathMatch && !isPlainMcp) {
        sendRpcError(res, 404, -32600, 'not found — the MCP endpoint is /mcp')
        return
      }
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const supplied = pathMatch ? decodeURIComponent(pathMatch[1]) : bearer
      // Kimlik: kişiye özel token eşleşirse o kişi, yoksa paylaşılan token.
      // İkisi de tutmuyorsa 401 — kişi bazlı kimlik yetkiyi GENİŞLETMEZ, sadece
      // kimin geçtiğini adlandırır. Eşleşmeyen token hâlâ kapıda kalır.
      const kisi = resolveActor(supplied, TOKEN_STORE, deps.config.consumer ?? 'unknown')
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
        // Kapının kendisi: oturum, onu açan kimlik bilgisine aittir. Geçerli bir
        // token taşımak konuşma hakkı vermez — AYNI token olmalı. Bu kontrol
        // olmadan, kişisel token'la açılmış bir oturumun id'sini ele geçiren
        // paylaşılan-token sahibi, o kişinin profil/maskeleme bağlamıyla çalışır
        // ve o andan sonraki her makbuz yanlış kişiyi adlandırır.
        if (!sessionOwnerMatches(existing.owner, supplied)) {
          sendRpcError(res, 403, -32003, 'session owner mismatch')
          return
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await existing.transport.handleRequest(req, res, body)
        return
      }

      // Oturum kimliği GELDİ ama sunucuda yok: yeniden başlatılmış geçit, ya da
      // süresi dolmuş oturum. Spec bunun için 404 der — istemcinin yapması gereken
      // yeni bir initialize açmaktır. 400 "isteğin bozuk" demektir; istemci bunu
      // toparlanma sinyali saymaz ve bağlantı kalıcı olarak ölür. Canlıda tam olarak
      // bu yaşandı: 03:38'deki yeniden başlatmadan sonra konnektör bir daha açılmadı.
      if (sessionId) {
        sendRpcError(res, 404, -32004, 'session not found — send a new initialize request')
        return
      }

      // Yeni oturum: yalnız initialize POST açar
      if (req.method !== 'POST') {
        sendRpcError(res, 400, -32600, 'no session — open one with an initialize POST')
        return
      }
      const body = await readBody(req)
      if (!isInitializeRequest(body)) {
        sendRpcError(res, 400, -32600, 'expected initialize')
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
      try { if (!res.headersSent) sendRpcError(res, 500, -32603, 'internal error') } catch { /* */ }
    }
  }
}

async function main() {
  if (!TOKEN || TOKEN.length < 24) {
    console.error('[conarium-http] CONARIUM_MCP_TOKEN eksik ya da <24 karakter — fail-closed, başlamıyorum.')
    process.exit(1)
  }

  const config = loadConfig()
  const ratePerMin = resolveHttpRatePerMin(config)
  const deps = await bootDeps(config)
  const transports = new Map<string, SessionEntry>()
  const limiter = new RateLimiter({ perWindow: ratePerMin })
  const sweepTimer = setInterval(() => limiter.sweep(), 5 * 60_000)
  sweepTimer.unref()

  const httpServer = createHttpServer(createHandler(deps, transports, limiter))

  httpServer.listen(PORT, HOST, () => {
    const addr = httpServer.address()
    const bound = typeof addr === 'object' && addr !== null ? addr.port : PORT
    const rate = limiter.enabled ? `${ratePerMin}/dk` : 'KAPALI'
    console.error(
      `[conarium-http] remote MCP hazır — http://${HOST}:${bound} (token: SET, ${deps.connectors.length} connector, rate-limit: ${rate})`
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
