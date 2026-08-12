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
  const kayit = { status: 0, body: '', headersSent: false }
  return {
    kayit,
    writeHead(status) { kayit.status = status; kayit.headersSent = true; return this },
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

  it('sahiplik anahtarı ham token değil, karmasıdır', () => {
    const key = ownerKey(AYSE)
    expect(key.toString('hex')).toBe(sha256hex(AYSE))
    expect(key.toString('utf8')).not.toContain(AYSE)
  })
})
