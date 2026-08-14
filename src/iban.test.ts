/**
 * IBAN content detector.
 *
 * Checksum is the false-positive brake: a test that turns it off MUST go red
 * if production code ever drops the ISO 7064 remainder-1 check.
 */
import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'
import { ibanMod97Ok, looksLikeIban, maskIbansInText, normalizeIban } from './iban.js'
import type { GovernancePolicy } from './types.js'

/** Brute-force the two check digits so tests do not hard-code a live account. */
function validIban(country: string, bban: string): string {
  for (let i = 0; i < 100; i++) {
    const n = country.toUpperCase() + String(i).padStart(2, '0') + bban
    if (ibanMod97Ok(n)) return n
  }
  throw new Error(`no check digits for ${country}+${bban}`)
}

const TR = validIban('TR', '0006100519786457841322')
const DE = 'DE89370400440532013000' // well-known test IBAN, remainder 1
const INVALID_TR = 'TR000000000000000000000000' // demo-bank zero pattern, checksum fails

describe('IBAN checksum', () => {
  it('ISO 7064 remainder-1 accepts a known-valid DE IBAN', () => {
    expect(ibanMod97Ok(DE)).toBe(true)
  })

  it('generated TR IBAN is 26 chars and remainder 1', () => {
    expect(TR).toHaveLength(26)
    expect(ibanMod97Ok(TR)).toBe(true)
    expect(looksLikeIban(TR)).toBe(true)
  })

  it('all-zero TR shape looks like an IBAN but fails checksum', () => {
    expect(looksLikeIban(INVALID_TR)).toBe(true)
    expect(ibanMod97Ok(INVALID_TR)).toBe(false)
  })
})

describe('IBAN content detector', () => {
  const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

  it('masks a valid IBAN in free text when maskColumns does not list it', () => {
    const r = gov.maskPII(`havale ${TR} tamam`)
    expect(r.masked).toBe('havale [MASKED_PII] tamam')
    expect(r.count).toBeGreaterThan(0)
  })

  it('masks grouped written form (spaces)', () => {
    const grouped = TR.replace(/(.{4})/g, '$1 ').trim()
    expect(grouped).toMatch(/\s/)
    const r = gov.maskPII(`IBAN: ${grouped}`)
    expect(r.masked).toBe('IBAN: [MASKED_PII]')
    expect(String(r.masked)).not.toContain(TR.slice(0, 6))
  })

  it('does not mask a checksum-failing lookalike (false-positive brake)', () => {
    const r = gov.maskPII(`ref ${INVALID_TR} tutar 1500.50 TL tarih 2026-08-13`)
    expect(r.masked).toContain(INVALID_TR)
    expect(r.masked).toContain('1500.50')
    expect(r.masked).toContain('2026-08-13')
    expect(r.count).toBe(0)
  })

  it('checksum OFF → the same lookalike IS masked — remove the brake and this goes red', () => {
    // Mutation test: production maskIbansInText defaults checksum:true.
    // If someone deletes the remainder-1 check, maskIbansInText(INVALID_TR)
    // would already count 1 with the default, and the assertion below
    // (`default count === 0`) in the previous test still catches that.
    // This test proves the flag actually controls the brake: disabling it
    // MUST change the outcome. If it does not, we are not measuring checksum.
    expect(maskIbansInText(INVALID_TR).count).toBe(0)
    expect(maskIbansInText(INVALID_TR, { checksum: false }).count).toBe(1)
    expect(maskIbansInText(INVALID_TR, { checksum: false }).text).toBe('[MASKED_PII]')
  })

  it('redact: IBAN column not in maskColumns still masked; amount and date survive', () => {
    const out = gov.redact({
      rows: [{
        _table: 'public.notes',
        memo: `ödeme ${TR} alındı`,
        payment_ref: TR,
        amount_try: 1500.5,
        booked_on: '2026-08-13',
      }],
      rowCount: 1,
      fields: ['memo', 'payment_ref', 'amount_try', 'booked_on'],
    } as never)
    const row = out.rows[0] as Record<string, unknown>
    expect(row.memo).toBe('ödeme [MASKED_PII] alındı')
    expect(row.payment_ref).toBe('[MASKED_PII]')
    expect(row.amount_try).toBe(1500.5)
    expect(row.booked_on).toBe('2026-08-13')
  })

  it('does not leave a half-masked TR…[MASKED_PII] tail', () => {
    const r = gov.maskPII(TR)
    expect(r.masked).toBe('[MASKED_PII]')
    expect(String(r.masked)).not.toMatch(/^TR/)
  })

  /**
   * 08-13'te kapida yakalandi: bir alanda IKI IBAN varsa yalnizca ilki
   * maskeleniyordu, ikincisi TAMAMEN acik geciyordu (count=1).
   * Sebep tasarimdaydi: tek acgozlu aday regex ayraci ("... ve ...") yutup
   * {11,30} sinirinda IKINCI IBAN'IN ORTASINDA kesiliyor, String.replace de
   * eslesmenin sonundan devam ettigi icin kalan parca hicbir desene uymuyordu.
   * "X hesabindan Y hesabina" bir odeme metninde kenar durum degildir.
   */
  it('ayni alandaki IKI IBAN da maskelenir (duz + gruplu, her sirada)', () => {
    const grouped = TR.replace(/(.{4})/g, '$1 ').trim()
    for (const metin of [
      `${TR} ve ${grouped} ayni hesap.`,
      `${grouped} ve ${TR} ayni hesap.`,
      `${grouped} ve ${grouped} ayni.`,
    ]) {
      const r = gov.maskPII(metin)
      const out = String(r.masked)
      expect(out).not.toMatch(/TR\s?\d\d/)               // hicbir IBAN acik kalmadi
      expect(out.match(/\[MASKED_PII\]/g)?.length).toBe(2) // ikisi de maskelendi
      expect(out).toMatch(/ayni/)                          // cumlenin geri kalani duruyor
    }
  })

  it('profile cannot switch the detector off', () => {
    const policy: GovernancePolicy = {
      allowTables: ['public.notes'],
      maskColumns: ['*.customer_name'],
      profiles: { patron: { maskColumns: [] } },
      actorProfiles: { emekcan: 'patron' },
    }
    const g = new Governance(policy).forActor({ id: 'emekcan', assurance: 'per-user-token' })
    const out = g.redact({
      rows: [{ _table: 'public.notes', not: `iletisim ${TR}` }],
      fields: ['not'],
      rowCount: 1,
    } as never)
    expect((out.rows[0] as Record<string, unknown>).not).toBe('iletisim [MASKED_PII]')
  })
})

describe('G15 — glued IBAN prefix', () => {
  const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

  it('acctTR33… is masked (no word-boundary required)', () => {
    const r = gov.maskPII(`acct${TR}`)
    expect(String(r.masked)).not.toContain(TR)
    expect(String(r.masked)).toMatch(/MASKED/)
  })
})

describe('IBAN normalize', () => {
  it('drops spaces and hyphens', () => {
    expect(normalizeIban('TR12 3456-7890')).toBe('TR1234567890')
  })
})
