import { describe, expect, it } from 'vitest'
import { compileCustomPatterns, maskField } from './mask.js'

// A gate in front of an agent's tool calls decides per class: mask the TCKN,
// let the e-mail address through. maskField has to say which classes it found,
// and mask only the ones it is asked to. The counts never carry the values.

const TCKN = '10000000146'
const EMAIL = 'ayse.yilmaz@example.com'
const TEXT = `mail ${EMAIL} TCKN ${TCKN}`

describe('maskField: classes and only', () => {
  it('counts what it found per built-in class', () => {
    const r = maskField(TEXT, { pipeline: 'text' })
    expect(r.classes).toEqual({ email: 1, tckn: 1 })
    expect(r.masked).toEqual({ email: 1, tckn: 1 })
    expect(JSON.stringify([r.classes, r.masked])).not.toMatch(/example\.com|10000000146/)
  })

  it('without only, the text is what it was before the option existed', () => {
    expect(maskField(TEXT, { pipeline: 'text' }).text).toBe('mail [MASKED_PII] TCKN [MASKED_PII]')
  })

  it('only masks the listed classes and leaves the others', () => {
    const r = maskField(TEXT, { pipeline: 'text', only: ['tckn'] })
    expect(r.text).toContain(EMAIL)
    expect(r.text).not.toContain(TCKN)
    expect(r.classes).toEqual({ email: 1, tckn: 1 })
    expect(r.masked).toEqual({ tckn: 1 })
  })

  it('an empty only masks nothing the core classified', () => {
    const r = maskField(TEXT, { pipeline: 'text', only: [] })
    expect(r.text).toBe(TEXT)
    expect(r.classes).toEqual({ email: 1, tckn: 1 })
    expect(r.masked).toEqual({})
  })

  it('a whole-field outcome stays whole under only, and says so', () => {
    const long = `${'x'.repeat(60)} ${TCKN}`
    const r = maskField(long, { pipeline: 'text', scanCharCap: 20, only: [] })
    expect(r.text).toBe('[MASKED_PII]')
    expect(r.masked).toEqual({ whole: 1 })
  })

  // Cursor (Sol) review of 0.3.3: "^|SECRET" on "SECRET" gave "[MASKED_PII]SECRET" with
  // masked { custom: 1 }: a zero-length match was counted as masked while the secret stayed.
  // Patterns that can match the empty string stay allowed (custom_patterns.edges.test.ts relies on
  // them); what changes is that the counts only report what was actually replaced.
  it('a zero-length match is not counted as found or masked', () => {
    const customPatterns = compileCustomPatterns([{ name: 'z', pattern: '^|SECRET' }])
    const r = maskField('SECRET', { pipeline: 'text', customPatterns })
    expect(r.masked.custom ?? 0).toBe(0)
    expect(r.classes.custom ?? 0).toBe(0)
  })

  it('phone and iban are counted under their own names', () => {
    const r = maskField(`TC ${TCKN}, tel 0532 123 45 67, IBAN TR33 0006 1005 1978 6457 8413 26`, { pipeline: 'text' })
    expect(r.classes).toEqual({ tckn: 1, phone: 1, iban: 1 })
  })
})
