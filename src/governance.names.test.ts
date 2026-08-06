import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'
import type { GovernancePolicy, QueryResult } from './types.js'

function rows(...r: Record<string, unknown>[]): QueryResult {
  return { rows: r, rowCount: r.length, fields: Object.keys(r[0] ?? {}) }
}

// Katman A — CAPRAZ ALAN SIZINTISI.
// maskColumns bir sutunu PII ilan ediyor, ama AYNI sonuc kumesindeki serbest
// metin alaninda gecen AYNI deger ham gidiyordu.
describe('isim tespiti — maskeli sutun degeri serbest metinde', () => {
  it('maskelenen sutunun degeri ayni satirin not alaninda da maskelenir', () => {
    const gov = new Governance({ maskColumns: ['*.customer_name'] })
    const out = gov.redact(rows({
      _table: 'zion.customers',
      customer_name: 'Ahmet Yilmaz',
      note: 'Ahmet Yilmaz ile gorusuldu, odeme sozu verdi',
    }))
    expect(out.rows[0].customer_name).toBe('[MASKED_PII]')
    expect(out.rows[0].note).not.toContain('Ahmet Yilmaz')
  })

  it('bir satirin ismi BASKA satirin serbest metninde de maskelenir', () => {
    const gov = new Governance({ maskColumns: ['*.customer_name'] })
    const out = gov.redact(rows(
      { _table: 'zion.customers', customer_name: 'Ayse Demir', note: '-' },
      { _table: 'zion.customers', customer_name: 'Mehmet Kaya', note: 'Ayse Demir referansiyla geldi' },
    ))
    expect(out.rows[1].note).not.toContain('Ayse Demir')
  })
})

// Katman B — ETIKETLI ISIM.
// Baglamsiz isim tespiti (NER) YOK ve iddia edilmiyor; yalnizca unvan/etiket
// ile isaretlenmis isimler maskeleniyor.
describe('isim tespiti — etiketli isimler', () => {
  const gov = new Governance({})

  it('unvanla yazilmis ismi maskeler', () => {
    const r = gov.maskPII('Sn. Ahmet Yilmaz bugun aradi')
    expect(r.masked).not.toContain('Ahmet Yilmaz')
    expect(r.count).toBeGreaterThan(0)
  })

  it('etiketli alandaki ismi maskeler', () => {
    expect(gov.maskPII('Yetkili: Ayse Demir').masked).not.toContain('Ayse Demir')
  })
})

// Bir maskeleme urununde asil risk fazla maskelemek DEGIL, ciktiyi kullanilamaz
// hale getirmek: cok kisa bir deger her yerde eslesir, sinirsiz eslesme kelime
// ortasini keser. Bu blok o iki tuzagi kilitler.
describe('isim tespiti — yanlis pozitif korumasi', () => {
  it('3 karakterden kisa maskeli deger serbest metinde TASINMAZ', () => {
    // Bilincli odun: "AB" gibi bir deger tam kelime olarak da her yerde geciyor.
    // Tasisaydik cikti okunamaz hale gelirdi; esik burada kilitli.
    const gov = new Governance({ maskColumns: ['*.kod'] })
    const out = gov.redact(rows({ _table: 'zion.urunler', kod: 'AB', aciklama: 'AB serisi koltuk takimi' }))
    expect(out.rows[0].aciklama).toBe('AB serisi koltuk takimi')
  })

  it('maskeli deger kelime ORTASINDA eslesmez', () => {
    const gov = new Governance({ maskColumns: ['*.customer_name'] })
    const out = gov.redact(rows({ _table: 'zion.customers', customer_name: 'Ali', note: 'Kalite kontrolu tamam, Ali onayladi' }))
    expect(out.rows[0].note).toBe('Kalite kontrolu tamam, [MASKED_PII] onayladi')
  })

  it('uzun eslesme once uygulanir — "Demir" kalintisi kalmaz', () => {
    const gov = new Governance({ maskColumns: ['*.customer_name', '*.tedarikci'] })
    const out = gov.redact(rows({
      _table: 'zion.customers',
      customer_name: 'Ayse Demir',
      tedarikci: 'Demir',
      note: 'Ayse Demir siparisi verdi',
    }))
    expect(out.rows[0].note).toBe('[MASKED_PII] siparisi verdi')
  })

  it('etiket benzeri kelimenin ICINDEKI etiket tetiklemez (filename)', () => {
    const gov = new Governance({})
    expect(gov.maskPII('filename: Rapor').masked).toBe('filename: Rapor')
  })

  it('isim olmayan etiketli alan maskelenmez', () => {
    const gov = new Governance({})
    expect(gov.maskPII('Urun: Koltuk Takimi').masked).toBe('Urun: Koltuk Takimi')
    expect(gov.maskPII('bu ay ciro artti, marj iyi').count).toBe(0)
  })
})

// Isim maskesi AI icin dogru, veri sorumlusu icin yanlis — genel anahtar degil,
// kisi bazli profil. Ayni disiplin: [[governance.profiles.test.ts]].
describe('isim tespiti — profil kontrolu', () => {
  const POLICY: GovernancePolicy = {
    maskColumns: ['*.customer_name'],
    profiles: { 'controller-full': { maskColumns: [], maskLabelledNames: false } },
    actorProfiles: { emekcan: 'controller-full' },
  }
  const PATRON = { id: 'emekcan', assurance: 'per-user-token' as const }

  it('taban politikada etiketli isim maskelenir', () => {
    expect(new Governance(POLICY).maskPII('Yetkili: Ayse Demir').masked).toContain('[MASKED_PII]')
  })

  it('profil etiketli isim maskesini kapatabilir', () => {
    const g = new Governance(POLICY).forActor(PATRON)
    expect(g.maskPII('Yetkili: Ayse Demir').masked).toBe('Yetkili: Ayse Demir')
  })

  it('PAYLASILAN token profil ALAMAZ — isim maskesi acik kalir', () => {
    const g = new Governance(POLICY).forActor({ id: 'emekcan', assurance: 'shared-token' })
    expect(g.maskPII('Yetkili: Ayse Demir').masked).toContain('[MASKED_PII]')
  })
})
