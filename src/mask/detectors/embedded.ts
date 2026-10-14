/**
 * Embedded hex and base64 tokens whose decoded text is PII.
 */
import { maskIbansInText } from '../../iban.js'
import { decodedLooksLikePii } from '../../pii_normalize.js'
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
const B64_RE = /(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{16,80}={0,2})(?![A-Za-z0-9+/=])/g
const HEX_RE = /\b([0-9A-Fa-f]{24,80})\b/g

function decodedIsPii(token: string, encoding: 'base64' | 'hex'): boolean {
  if (token.includes('[MASKED')) return false
  try {
    const decoded = Buffer.from(token, encoding).toString('utf8')
    if (!decoded || decoded.includes('\u0000')) return false
    return decodedLooksLikePii(decoded) || maskIbansInText(decoded).count > 0
  } catch {
    return false
  }
}

export function detectEmbeddedSpans(text: string): Span[] {
  if (text.length > 80 && /^\d+$/.test(text)) return []
  const out: Span[] = []
  const b64 = new RegExp(B64_RE.source, B64_RE.flags)
  for (const m of text.matchAll(b64)) {
    if (m.index === undefined) continue
    const token = m[1] ?? m[0]
    if (!decodedIsPii(token, 'base64')) continue
    const start = m.index + m[0].indexOf(token)
    out.push({ start, end: start + token.length, cls: 'embedded', token: PII, source: 'embedded' })
  }
  const hex = new RegExp(HEX_RE.source, HEX_RE.flags)
  for (const m of text.matchAll(hex)) {
    if (m.index === undefined) continue
    const token = m[1] ?? m[0]
    if (token.length % 2 !== 0) continue
    if (!decodedIsPii(token, 'hex')) continue
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      cls: 'embedded',
      token: PII,
      source: 'embedded',
    })
  }
  return out
}
