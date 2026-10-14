/**
 * Whole-field base64 whose decoded text contains email, numeric PII, or an IBAN.
 */
import { maskEmails, maskNumericPii } from '../../digit_pii.js'
import { maskIbansInText } from '../../iban.js'
import type { WholeField } from '../core.js'

const PII = '[MASKED_PII]'

export function detectWholeFieldBase64(text: string): WholeField | undefined {
  const candidate = text.trim()
  if (candidate.length < 12 || candidate.length > 256) return undefined
  if (!/^[A-Za-z0-9+/]{12,}={0,2}$/.test(candidate)) return undefined
  try {
    const decoded = Buffer.from(candidate, 'base64').toString('utf8')
    if (!decoded || decoded.includes('\u0000')) return undefined
    if (
      maskEmails(decoded).count > 0
      || maskNumericPii(decoded).count > 0
      || maskIbansInText(decoded).count > 0
    ) {
      return { token: PII, reason: 'base64' }
    }
  } catch {
    return undefined
  }
  return undefined
}
