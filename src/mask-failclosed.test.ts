/**
 * If the masking core throws, the field is masked whole. A masking error must
 * not hand back the raw value, and must not stop the caller either.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./mask/core.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./mask/core.js')>()
  return {
    ...real,
    detect: () => {
      throw new Error('detector failure')
    },
  }
})

const { maskSensitiveText } = await import('./mask-text.js')
const { Governance } = await import('./governance.js')

describe('a core that throws masks the field whole', () => {
  it('maskSensitiveText', () => {
    expect(maskSensitiveText('ahmet@example.com 05321234567')).toBe('[MASKED_PII]')
  })
  it('Governance.maskPII', () => {
    const res = new Governance({}).maskPII('ahmet@example.com 05321234567')
    expect(res.masked).toBe('[MASKED_PII]')
    expect(res.count).toBe(1)
  })
})
