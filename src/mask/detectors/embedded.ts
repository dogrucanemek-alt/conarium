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
  const prevB64 = B64_RE.lastIndex
  B64_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = B64_RE.exec(text)) !== null) {
      const token = m[1] ?? m[0]
      if (decodedIsPii(token, 'base64')) {
        const start = m.index + m[0].indexOf(token)
        out.push({ start, end: start + token.length, cls: 'embedded', token: PII, source: 'embedded' })
      }
      if (B64_RE.lastIndex === m.index) {
        B64_RE.lastIndex = m.index + 1
        if (B64_RE.lastIndex > text.length) break
      }
    }
  } finally {
    B64_RE.lastIndex = prevB64
  }
  const prevHex = HEX_RE.lastIndex
  HEX_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = HEX_RE.exec(text)) !== null) {
      const token = m[1] ?? m[0]
      if (token.length % 2 === 0 && decodedIsPii(token, 'hex')) {
        out.push({
          start: m.index,
          end: m.index + m[0].length,
          cls: 'embedded',
          token: PII,
          source: 'embedded',
        })
      }
      if (HEX_RE.lastIndex === m.index) {
        HEX_RE.lastIndex = m.index + 1
        if (HEX_RE.lastIndex > text.length) break
      }
    }
  } finally {
    HEX_RE.lastIndex = prevHex
  }
  return out
}
