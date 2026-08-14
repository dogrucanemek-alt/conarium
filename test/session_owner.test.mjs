/**
 * test/session_owner.test.mjs
 *
 * Oturum devralma regresyonu.
 *
 * Açık şuydu: `Mcp-Session-Id` yalnızca yönlendirme bilgisiydi. Geçerli HERHANGİ
 * bir token taşıyan istemci, başka birinin oturum id'sini sunarak o oturumun
 * kimliğiyle konuşabiliyordu — çünkü Server nesnesi oturum açılırken bir kez
 * kurulur ve o andan sonraki her istek onun kimliğiyle çalışır. Sonuç: makbuz
 * yanlış kişiyi adlandırır. Ürünün tek gerçek vaadi budur, o yüzden bu test
 * kimlik doğrulamayı değil, KİMLİĞİN DOĞRU KİŞİYE BAĞLANDIĞINI ölçer.
 *
 * Oturum id'si sır değildir: düz başlıkta gider, vekil sunucu kaydına düşer.
 * Bu yüzden iki kimlik arasında duran tek şey o olamaz.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PAYLASILAN = 'paylasilan-token-en-az-24-karakter-uzun'
const AYSE = 'ayse-kisisel-token-en-az-24-karakter'
const YABANCI = 'gecersiz-token-hicbir-yerde-kayitli-degil'

const sha256hex = s => createHash('sha256').update(s).digest('hex')

let createHandler, ownerKey

beforeAll(async () => {
  // TOKEN ve TOKEN_STORE modül yüklenirken okunuyor — import'tan ÖNCE kurulmalı,
  // yoksa test kendi kurduğu dünyayı değil, boş bir dünyayı ölçer.
  const dir = mkdtempSync(join(tmpdir(), 'cnr-session-'))
  const tokensFile = join(dir, 'conarium.tokens.json')
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ sha256: sha256hex(AYSE), id: 'ayse' }] }))
  process.env.CONARIUM_TOKENS_FILE = tokensFile
  process.env.CONARIUM_MCP_TOKEN = PAYLASILAN
  const mod = await import('../src/http.ts')
  createHandler = mod.createHandler
  ownerKey = mod.ownerKey
})

// ─── sahte HTTP çifti ────────────────────────────────────────────────────────

function sahteIstek({ method = 'GET', token, sessionId }) {
  return {
    url: '/mcp',
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function sahteYanit() {
  const kayit = { status: 0, body: '', headersSent: false, headers: {} }
  return {
    kayit,
    writeHead(status, headers) { kayit.status = status; kayit.headers = headers || {}; kayit.headersSent = true; return this },
    end(body) { kayit.body = String(body ?? '') },
    get headersSent() { return kayit.headersSent },
  }
}

const deps = { config: { consumer: 'servis' }, connectors: [], governance: {}, audit: {} }
const limiter = { take: () => true, retryAfter: () => 0, enabled: false }

/** Ayşe'nin açtığı bir oturumu elle kurar; transport'a dokunulup dokunulmadığını izler. */
function ayseninOturumu() {
  const izleme = { cagrildi: false }
  const transport = { handleRequest: async () => { izleme.cagrildi = true } }
  const transports = new Map([['oturum-ayse', { transport, owner: ownerKey(AYSE) }]])
  return { transports, izleme }
}

// ─── testler ─────────────────────────────────────────────────────────────────

describe('oturum, onu açan kimliğe bağlıdır', () => {
  it('paylaşılan token, kişisel token ile açılmış oturumu DEVRALAMAZ', async () => {
    const { transports, izleme } = ayseninOturumu()
    const res = sahteYanit()

    // Mehmet'in kendi token'ı geçerli (paylaşılan) — kapıdan geçer. Ele geçirdiği
    // tek şey Ayşe'nin oturum id'si. Eskiden bu yetiyordu.
    await createHandler(deps, transports, limiter)(
      sahteIstek({ token: PAYLASILAN, sessionId: 'oturum-ayse' }),
      res,
    )

    expect(res.kayit.status).toBe(403)
    expect(res.kayit.body).toMatch(/session owner mismatch/)
    // Asıl ölçüm: transport'a HİÇ ulaşılmamalı. 403 dönüp isteği yine de
    // işlemek, kapıyı kapatıp pencereyi açık bırakmaktır.
    expect(izleme.cagrildi).toBe(false)
  })

  it('oturumun gerçek sahibi kendi oturumunda çalışmaya devam eder', async () => {
    const { transports, izleme } = ayseninOturumu()
    const res = sahteYanit()

    await createHandler(deps, transports, limiter)(
      sahteIstek({ token: AYSE, sessionId: 'oturum-ayse' }),
      res,
    )

    expect(res.kayit.status).toBe(0)      // sahiplik kontrolü hiçbir şey yazmadı
    expect(izleme.cagrildi).toBe(true)    // istek transport'a geçti
  })

  it('geçersiz token, oturum id doğru olsa bile kapıda kalır (401)', async () => {
    const { transports, izleme } = ayseninOturumu()
    const res = sahteYanit()

    await createHandler(deps, transports, limiter)(
      sahteIstek({ token: YABANCI, sessionId: 'oturum-ayse' }),
      res,
    )

    expect(res.kayit.status).toBe(401)
    expect(izleme.cagrildi).toBe(false)
  })

  /**
   * 2026-08-13 canlı arızası. Geçit 03:38'de yeniden başlatıldı; claude.ai elindeki
   * ESKİ oturum id'siyle gelmeye devam etti. Sunucu `400 expected initialize` +
   * text/plain dönüyordu: istemcinin proxy'si gövdeyi ayrıştıramayıp kullanıcıya
   * "Invalid content from server" dedi. Yani "oturumun düştü, yeniden aç" bilgisi
   * hiç ulaşmadı ve konnektör kalıcı olarak ölü kaldı — canlı demo 10 saat gitti.
   */
  it('bilinmeyen oturum id: 404 döner (400 DEĞİL) ve yeniden başlatmayı söyler', async () => {
    const { transports, izleme } = ayseninOturumu()
    const res = sahteYanit()

    await createHandler(deps, transports, limiter)(
      sahteIstek({ method: 'POST', token: PAYLASILAN, sessionId: 'restart-sonrasi-bayat-id' }),
      res,
    )

    // 404 = "oturum yok, yenisini aç" (spec). 400 = "isteğin bozuk" → istemci toparlanmaz.
    expect(res.kayit.status).toBe(404)
    expect(izleme.cagrildi).toBe(false)
    const govde = JSON.parse(res.kayit.body)
    expect(govde.jsonrpc).toBe('2.0')
    expect(govde.error.message).toMatch(/initialize/)
  })

  it('bilinmeyen oturum id GET ile de 404 verir', async () => {
    const { transports } = ayseninOturumu()
    const res = sahteYanit()
    await createHandler(deps, transports, limiter)(
      sahteIstek({ method: 'GET', token: PAYLASILAN, sessionId: 'yok-boyle-bir-oturum' }),
      res,
    )
    expect(res.kayit.status).toBe(404)
  })

  it('hata gövdeleri JSON-RPC, düz metin değil — yoksa istemci sebebi göremez', async () => {
    for (const [durum, istek] of [
      [401, sahteIstek({ token: YABANCI })],
      [403, sahteIstek({ token: PAYLASILAN, sessionId: 'oturum-ayse' })],
    ]) {
      const { transports } = ayseninOturumu()
      const res = sahteYanit()
      await createHandler(deps, transports, limiter)(istek, res)
      expect(res.kayit.status).toBe(durum)
      expect(res.kayit.headers['content-type']).toBe('application/json')
      expect(() => JSON.parse(res.kayit.body)).not.toThrow()
      expect(JSON.parse(res.kayit.body).jsonrpc).toBe('2.0')
    }
  })

  it('sahiplik anahtarı ham token değil, karmasıdır', () => {
    const key = ownerKey(AYSE)
    expect(key.toString('hex')).toBe(sha256hex(AYSE))
    expect(key.toString('utf8')).not.toContain(AYSE)
  })

  it('/.well-known/* is 404 text, not JSON-RPC and not a redirect', async () => {
    const paths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/t/conarium-public-demo-tryit-2026/mcp',
    ]
    for (const pathname of paths) {
      const res = sahteYanit()
      await createHandler(deps, new Map(), limiter)(
        { url: pathname, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        res,
      )
      expect(res.kayit.status).toBe(404)
      expect(res.kayit.headers['content-type']).toMatch(/^text\/plain/)
      expect(res.kayit.body).toBe('not found')
      expect(res.kayit.headers.location).toBeUndefined()
    }
  })
})
