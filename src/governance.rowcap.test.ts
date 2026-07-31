/**
 * SATIR SINIRI — kume islemlerinde (UNION/INTERSECT/EXCEPT) de uygulanmali.
 *
 * 2026-07-31'de NEO'nun guvenlik taramasinda bulundu, deneysel olarak dogrulandi:
 * `limitTarget` yalnizca 'select' ve 'with' tanıyor, kume islemleri undefined
 * dusuyor ve `applyRowCap` SESSIZCE cikiyor. Sonuc: UNION sorgusu satir sinirini
 * tamamen atliyor.
 *
 * Bu, urunun bes vaadinden birini deliyor ("row caps stop bulk extraction" —
 * ana sayfada, llms.txt'te ve compare.html'de yazili). Sessiz olmasi en kotu
 * yani: ne hata veriyor ne uyariyor, sadece butun satirlari donduruyor.
 */
import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'

const gov = () =>
  new Governance({
    allowTables: ['public.customers', 'public.customers_backup'],
    maxRows: 50,
  })

describe('satir siniri — kume islemleri', () => {
  it('duz SELECT sinirlanir (bugunku dogru davranis, korunuyor)', () => {
    const out = gov().guardQuery('SELECT * FROM public.customers')
    expect(out.sql).toMatch(/limit/i)
  })

  it('WITH sinirlanir (bugunku dogru davranis, korunuyor)', () => {
    const out = gov().guardQuery('WITH x AS (SELECT * FROM public.customers) SELECT * FROM x')
    expect(out.sql).toMatch(/limit/i)
  })

  it('UNION ALL sinirlanir — acigin kendisi', () => {
    const out = gov().guardQuery(
      'SELECT * FROM public.customers UNION ALL SELECT * FROM public.customers_backup',
    )
    expect(out.sql).toMatch(/limit/i)
  })

  it('UNION sinirlanir', () => {
    const out = gov().guardQuery(
      'SELECT * FROM public.customers UNION SELECT * FROM public.customers_backup',
    )
    expect(out.sql).toMatch(/limit/i)
  })

  it('EXCEPT/INTERSECT zaten REDDEDILIYOR — fail-closed, sessiz sizinti degil', () => {
    // Olculdu: pgsql-ast-parser bu iki kume islemini desteklemiyor, sozdizimi
    // hatasi atiyor ve guardQuery onu PolicyError'a ceviriyor. Yani sinirsiz
    // gecmiyorlar, hic gecmiyorlar. Ilk yazdigim beklenti ("sinirlanir") yanlisti;
    // test gercegi belgeliyor ki biri parser'i degistirdiginde bu durum gorunur olsun.
    expect(() =>
      gov().guardQuery('SELECT * FROM public.customers EXCEPT SELECT * FROM public.customers_backup'),
    ).toThrow(/parse/i)
    expect(() =>
      gov().guardQuery('SELECT * FROM public.customers INTERSECT SELECT * FROM public.customers_backup'),
    ).toThrow(/parse/i)
  })

  it('uygulanan sinir metadata da bildirilir', () => {
    const out = gov().guardQuery(
      'SELECT * FROM public.customers UNION ALL SELECT * FROM public.customers_backup',
    )
    expect(out.metadata.appliedRowCap).toBe(50)
  })

  it('politika kontrolu kume isleminde HALA calisiyor (yan etki yok)', () => {
    // Sarmalama, yasakli tabloyu union icinde gizlemeye izin vermemeli.
    expect(() =>
      gov().guardQuery('SELECT * FROM public.customers UNION ALL SELECT * FROM public.salaries'),
    ).toThrow()
  })
})
