/**
 * Kişi bazlı maskeleme profilleri.
 *
 * Bu özellik maskelemeyi GEVŞETEBİLDİĞİ için testlerin çoğu "gevşememesi gereken
 * yerler" üzerine. Bir profilin yanlışlıkla uygulanması = PII sızıntısı.
 */
import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'
import type { GovernancePolicy } from './types.js'

const POLICY: GovernancePolicy = {
  allowTables: ['zion.customers', 'zion.orders'],
  maskColumns: ['*.customer_name', '*.email', '*.phone'],
  maxRows: 100,
  profiles: {
    // Patron kendi token'ıyla müşteri adını görür; e-posta/telefon yine maskeli.
    'controller-full': { maskColumns: ['*.email', '*.phone'], maxRows: 1000 },
  },
  actorProfiles: { 'emekcan': 'controller-full' },
}

const PATRON = { id: 'emekcan', assurance: 'per-user-token' as const }
const ROW = [{ _table: 'zion.customers', customer_name: 'Ayşe Yılmaz', email: 'a@b.com', city: 'İzmir' }]

function maskedWith(g: Governance) {
  const out = g.redact({ rows: [...ROW.map((r) => ({ ...r }))], fields: [], rowCount: 1 } as never)
  return (out.rows as Record<string, unknown>[])[0]
}

describe('Governance.forActor — profil çözümü', () => {
  it('taban politikada müşteri adı maskelenir', () => {
    const row = maskedWith(new Governance(POLICY))
    expect(row.customer_name).toBe('[MASKED_PII]')
    expect(row.email).toBe('[MASKED_PII]')
  })

  it('per-user token + tanımlı profil: ad görünür, e-posta HÂLÂ maskeli', () => {
    const g = new Governance(POLICY).forActor(PATRON)
    expect(g.appliedProfile()).toBe('controller-full')
    const row = maskedWith(g)
    expect(row.customer_name).toBe('Ayşe Yılmaz')
    expect(row.email).toBe('[MASKED_PII]') // profil sadece istediğini açar
  })

  it('profil maxRows da ezebilir', () => {
    expect(new Governance(POLICY).maxRows()).toBe(100)
    expect(new Governance(POLICY).forActor(PATRON).maxRows()).toBe(1000)
  })

  // ─── gevşememesi gereken yerler ────────────────────────────────────────────

  it('PAYLAŞILAN token profil ALAMAZ — token kimdeyse PII onda olurdu', () => {
    const g = new Governance(POLICY).forActor({ id: 'emekcan', assurance: 'shared-token' })
    expect(g.appliedProfile()).toBeNull()
    expect(maskedWith(g).customer_name).toBe('[MASKED_PII]')
  })

  it('aktör yoksa taban politika', () => {
    const g = new Governance(POLICY).forActor(undefined)
    expect(g.appliedProfile()).toBeNull()
    expect(maskedWith(g).customer_name).toBe('[MASKED_PII]')
  })

  it('haritada olmayan kişi profil almaz', () => {
    const g = new Governance(POLICY).forActor({ id: 'baskasi', assurance: 'per-user-token' })
    expect(g.appliedProfile()).toBeNull()
    expect(maskedWith(g).customer_name).toBe('[MASKED_PII]')
  })

  it('tanımsız profil adına eşlenmiş kişi TABANA düşer, geniş olana değil', () => {
    const bozuk: GovernancePolicy = { ...POLICY, actorProfiles: { emekcan: 'olmayan-profil' } }
    const g = new Governance(bozuk).forActor(PATRON)
    expect(g.appliedProfile()).toBeNull()
    expect(maskedWith(g).customer_name).toBe('[MASKED_PII]')
  })

  it('profil TABLO iznini genişletemez — sadece maskeleme/satır sınırı ezilebilir', () => {
    const kotu = {
      ...POLICY,
      profiles: { 'controller-full': { maskColumns: [], allowTables: ['*'] } as never },
      actorProfiles: { emekcan: 'controller-full' },
    }
    const g = new Governance(kotu).forActor(PATRON)
    // allowTables profilde yazsa da yürürlüğe GİRMEZ: erişilebilirlik global kalır.
    expect(g.allowsTable('gizli.maaslar')).toBe(false)
    expect(g.allowsTable('zion.customers')).toBe(true)
  })

  it('taban Governance nesnesi DEĞİŞMEZ — forActor yeni nesne döner', () => {
    const taban = new Governance(POLICY)
    taban.forActor(PATRON)
    expect(taban.appliedProfile()).toBeNull()
    expect(maskedWith(taban).customer_name).toBe('[MASKED_PII]')
  })

  it('profil yapılandırılmamışsa davranış aynen eskisi gibi', () => {
    const sade: GovernancePolicy = { maskColumns: ['*.customer_name'], maxRows: 50 }
    const g = new Governance(sade).forActor(PATRON)
    expect(g.appliedProfile()).toBeNull()
    expect(g.maxRows()).toBe(50)
  })

  it('icerik tarayicisi profilden BAGIMSIZ calisir — e-posta deseni yine yakalanir', () => {
    // maskColumns tamamen bosaltilsa bile serbest metindeki e-posta/TCKN/kart
    // regex katmanindan gecer. Profil, sutun kuralini ezer; dedektoru KAPATMAZ.
    const acik: GovernancePolicy = {
      ...POLICY,
      profiles: { 'controller-full': { maskColumns: [] } },
    }
    const g = new Governance(acik).forActor(PATRON)
    const out = g.redact({
      rows: [{ _table: 'zion.customers', not: 'iletisim: veli@ornek.com' }],
      fields: [],
      rowCount: 1,
    } as never)
    expect((out.rows as Record<string, unknown>[])[0].not).toContain('[MASKED_PII]')
  })
})
