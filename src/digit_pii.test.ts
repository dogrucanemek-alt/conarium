import { describe, expect, it } from 'vitest'
import { Governance } from './governance.js'
import {
  PII_SCAN_CHAR_CAP,
  luhnOk,
  maskEntityEncodedEmails,
  maskNumericPii,
} from './digit_pii.js'
import { collapsePartialMask } from './pii_normalize.js'

const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

describe('numeric PII — no mid-run match', () => {
  it('Luhn-valid PAN is fully masked; no digit remains', () => {
    const r = gov.maskPII('kart 4111111111111111')
    expect(r.masked).toBe('kart [MASKED_PII]')
    expect(r.count).toBe(1)
    expect(String(r.masked)).not.toMatch(/\d/)
  })

  it('16-digit Luhn-invalid is not a card — left intact', () => {
    expect(luhnOk('1234567890123456')).toBe(false)
    const r = gov.maskPII('ref 1234567890123456')
    expect(r.masked).toBe('ref 1234567890123456')
    expect(r.count).toBe(0)
  })

  it('20-digit order number is not a card — left intact, count 0', () => {
    const r = gov.maskPII('siparis 12345678901234567890')
    expect(r.masked).toBe('siparis 12345678901234567890')
    expect(r.count).toBe(0)
  })

  it('isolated 13-digit Luhn-invalid is not a card', () => {
    expect(luhnOk('1234567890123')).toBe(false)
    const r = gov.maskPII('ref 1234567890123')
    expect(r.masked).toBe('ref 1234567890123')
    expect(r.count).toBe(0)
  })

  it('TCKN-shaped 11-digit run is fully masked', () => {
    const r = gov.maskPII('tckn 12345678901')
    expect(r.masked).toBe('tckn [MASKED_PII]')
    expect(r.count).toBe(1)
  })

  it('grouped Luhn-valid card is masked including separators', () => {
    const r = gov.maskPII('kart 4111 1111 1111 1111')
    expect(r.masked).toBe('kart [MASKED_PII]')
    expect(String(r.masked)).not.toMatch(/\d/)
  })

  it('KIRMA: phone lookaround gone → 16-digit PAN leaves a prefix', () => {
    // Production maskNumericPii must not emit a digit glued to the mask.
    const r = maskNumericPii('4111111111111111')
    expect(r.text).toBe('[MASKED_PII]')
    expect(r.text).not.toMatch(/\d\[MASKED_PII\]/)
    expect(r.count).toBe(1)
  })
})

describe('scan cap — fail-closed', () => {
  it('oversize field is fully masked, never skipped', () => {
    const big = '1'.repeat(PII_SCAN_CHAR_CAP + 1)
    const r = gov.maskPII(big)
    expect(r.masked).toBe('[MASKED_PII]')
    expect(r.count).toBe(1)
    expect(String(r.masked)).not.toContain('1')
  })

  it('KIRMA: returning the original on oversize would fail this', () => {
    const big = 'TR33' + '1'.repeat(PII_SCAN_CHAR_CAP)
    const r = gov.maskPII(big)
    expect(r.masked).toBe('[MASKED_PII]')
    expect(r.count).toBeGreaterThan(0)
  })
})

describe('collapsePartialMask — no quadratic when the mask is absent', () => {
  it('leaves a long digit field alone and does not glue a fake prefix', () => {
    const digits = '1'.repeat(8000)
    expect(collapsePartialMask(digits)).toBe(digits)
    expect(collapsePartialMask('411[MASKED_PII]')).toBe('[MASKED_PII]')
    expect(collapsePartialMask('TR33000610051[MASKED_PII]')).toBe('[MASKED_PII]')
  })
})

describe('HTML entity @ — scan copy only', () => {
  it('entity-encoded email is masked; non-email entity is left', () => {
    const hit = maskEntityEncodedEmails('yaz patron&#64;sirket.com')
    expect(hit.text).toBe('yaz [MASKED_PII]')
    expect(hit.count).toBe(1)
    const miss = maskEntityEncodedEmails('fiyat 5&#64; magaza')
    expect(miss.text).toBe('fiyat 5&#64; magaza')
    expect(miss.count).toBe(0)
  })
})
