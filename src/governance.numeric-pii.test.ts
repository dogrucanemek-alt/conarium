/**
 * SAYISAL PII — maskeleme yalnizca metinde calisiyordu.
 *
 * 2026-07-31'de NEO'nun guvenlik taramasinda bulundu, deneysel dogrulandi:
 *   tckn_metin  "12345678901"  -> [MASKED_PII]     (maskelendi)
 *   tckn_sayi    12345678901   -> 12345678901      (SIZDI)
 *   telefon_sayi  5551234567   -> 5551234567       (SIZDI)
 *
 * Ayni TC kimlik numarasi, metin olarak maskelenip sayi olarak modele ham
 * gidiyordu. Turkiye'de TCKN ve telefonun bigint tutulmasi yaygin oldugu icin
 * bu teorik degil gunluk bir durum. Urunun 1. vaadini deler: "kisisel veri
 * modele ULASMADAN maskelenir".
 *
 * Tasarim notu: sayilar metne cevrilip AYNI desenlerden gecirilir. Boylece
 * "hangi sayi PII'dir" diye ayri bir kural seti tutmak gerekmez — tek kaynak.
 */
import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'

const gov = () => new Governance({ allowTables: ['public.customers'], maskColumns: ['email'], maxRows: 100 })

function tekSatir(row: Record<string, unknown>) {
  return gov().redact({ rows: [row], rowCount: 1, columns: Object.keys(row) } as never, {}, undefined).rows[0]
}

describe('sayisal PII maskeleme', () => {
  it('TCKN sayi olarak da maskelenir (metinle ayni davranis)', () => {
    const r = tekSatir({ tckn_metin: '12345678901', tckn_sayi: 12345678901 })
    expect(r.tckn_metin).toBe('[MASKED_PII]')
    expect(String(r.tckn_sayi)).toBe('[MASKED_PII]')
  })

  it('telefon sayi olarak da maskelenir', () => {
    const r = tekSatir({ telefon: 5551234567 })
    expect(String(r.telefon)).toBe('[MASKED_PII]')
  })

  it('MASUM sayilar bozulmaz — id, adet, fiyat, yil', () => {
    // En buyuk risk asiri maskeleme: her sayiyi maskelersek urun ise yaramaz.
    const r = tekSatir({ id: 1, adet: 42, fiyat: 1999.9, yil: 2026, stok: 100000 })
    expect(r.id).toBe(1)
    expect(r.adet).toBe(42)
    expect(r.fiyat).toBe(1999.9)
    expect(r.yil).toBe(2026)
    expect(r.stok).toBe(100000)
  })

  it('boolean ve null bozulmaz', () => {
    const r = tekSatir({ aktif: true, silindi: null })
    expect(r.aktif).toBe(true)
    expect(r.silindi).toBeNull()
  })
})
