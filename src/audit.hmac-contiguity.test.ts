/**
 * HMAC bitişiklik kuralı — F1/F5'in HMAC tarafı.
 *
 * F1 (2026-07-29) Ed25519 için şunu ayırt etmişti: *"bu anahtarla doğrulanamaz"* ile
 * *"kurcalanmış"* aynı şey DEĞİLDİR. İmza taşımayan eski satırlar kurcalanmış sayılınca
 * mevcut her kurulum Ed25519 açıldığı anda açılmıyordu. Çözüm bitişiklik kuralıydı:
 * imza taşıyan İLK satırdan sonra imzasızlık kabul edilmez, ondan öncesi eski kayıttır.
 *
 * Aynı kusur HMAC tarafında AÇIK KALMIŞTI ve 2026-08-05'te canlıda çarptı: Hetzner'daki
 * c2/c3 denetim dosyaları 17 Tem kodundan geliyordu ve hiç imza taşımıyordu; HMAC anahtarı
 * verilince `validateChain` "entry signature mismatch" atıp sunucuyu KALDIRMADI. HMAC o gün
 * kapatılmak zorunda kalındı — ama HMAC'siz kurulum strip-all saldırısına açık
 * (RECEIPT-SPEC known gap #4: dosyaya yazabilen biri tüm `sig`leri silip hash'leri yeniden
 * hesaplayabilir; HMAC anahtarlı olduğu için taklit edilemez ve tam da bunu yakalar).
 *
 * KURAL (Ed25519 ile birebir aynı):
 *   imza YOK  + henüz imzalı satır görülmedi → ESKİ KAYIT, kabul
 *   imza YOK  + daha önce imzalı satır var   → STRIP GİRİŞİMİ, reddet
 *   imza VAR  ama eşleşmiyor                 → KURCALAMA, her zaman reddet
 */
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { computeEntryHash, GENESIS_HASH } from './audit-hash.js'

const HMAC = 'example-not-a-real-key'
let eskiHmac: string | undefined

beforeEach(() => {
  eskiHmac = process.env.CONARIUM_AUDIT_HMAC_KEY
})
afterEach(() => {
  if (eskiHmac === undefined) delete process.env.CONARIUM_AUDIT_HMAC_KEY
  else process.env.CONARIUM_AUDIT_HMAC_KEY = eskiHmac
})

/** Zincir kurar. imzali[i] === true ise o satıra geçerli HMAC imzası yazılır. */
function sinkYaz(imzali: boolean[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'conarium-hmac-bitisik-'))
  const sink = join(dir, 'audit.jsonl')
  let prev = GENESIS_HASH
  const satirlar: string[] = []

  for (let i = 0; i < imzali.length; i++) {
    const entry: Record<string, unknown> = {
      timestamp: `2026-07-17T10:0${i}:00.000Z`,
      tool: 'query',
      target: `demo.t${i}`,
      denied: false,
      actor: 'remote-mcp',
      prevHash: prev,
    }
    const hash = computeEntryHash(entry)
    entry.hash = hash
    if (imzali[i]) {
      entry.signature = createHmac('sha256', HMAC).update(hash).digest('hex')
    }
    satirlar.push(JSON.stringify(entry))
    prev = hash
  }
  writeFileSync(sink, satirlar.join('\n') + '\n')
  return sink
}

describe('HMAC bitişiklik kuralı', () => {
  it('TAMAMEN imzasız eski zincir + HMAC anahtarı → AÇILIR (canlıda çarpan hata)', () => {
    process.env.CONARIUM_AUDIT_HMAC_KEY = HMAC
    const sink = sinkYaz([false, false, false])
    // Eskiden: "entry signature mismatch" → sunucu hiç kalkmıyordu.
    expect(() => new Audit({ sink })).not.toThrow()
  })

  it('imzasız satırlardan SONRA imzalı satırlar → AÇILIR (geçiş dönemi)', () => {
    process.env.CONARIUM_AUDIT_HMAC_KEY = HMAC
    const sink = sinkYaz([false, false, true, true])
    expect(() => new Audit({ sink })).not.toThrow()
  })

  it('imzalı satırdan SONRA imzasız satır → REDDEDİLİR (strip girişimi)', () => {
    process.env.CONARIUM_AUDIT_HMAC_KEY = HMAC
    const sink = sinkYaz([true, true, false])
    expect(() => new Audit({ sink })).toThrow(/contiguity|signature/i)
  })

  it('imza VAR ama yanlış → her zaman REDDEDİLİR (kurcalama)', () => {
    process.env.CONARIUM_AUDIT_HMAC_KEY = HMAC
    const dir = mkdtempSync(join(tmpdir(), 'conarium-hmac-yanlis-'))
    const sink = join(dir, 'audit.jsonl')
    const entry: Record<string, unknown> = {
      timestamp: '2026-07-17T10:00:00.000Z',
      tool: 'query',
      target: 'demo.t',
      denied: false,
      actor: 'remote-mcp',
      prevHash: GENESIS_HASH,
    }
    entry.hash = computeEntryHash(entry)
    entry.signature = createHmac('sha256', 'baska-anahtar').update(entry.hash as string).digest('hex')
    writeFileSync(sink, JSON.stringify(entry) + '\n')

    expect(() => new Audit({ sink })).toThrow(/signature mismatch/i)
  })

  it('imzalı → imzasız → imzalı sıçraması REDDEDİLİR (araya satır sokma)', () => {
    process.env.CONARIUM_AUDIT_HMAC_KEY = HMAC
    const sink = sinkYaz([true, false, true])
    expect(() => new Audit({ sink })).toThrow(/contiguity|signature/i)
  })

  it('HMAC anahtarı YOKKEN imzasız zincir hâlâ okunur (geriye uyum)', () => {
    delete process.env.CONARIUM_AUDIT_HMAC_KEY
    process.env.CONARIUM_AUDIT_UNSIGNED = '1'
    const sink = sinkYaz([false, false])
    expect(() => new Audit({ sink })).not.toThrow()
    delete process.env.CONARIUM_AUDIT_UNSIGNED
  })
})
