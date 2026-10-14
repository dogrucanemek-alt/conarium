/**
 * Secret-shaped tokens. Union of the audit-path and response-path patterns.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'

const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{6,}|sk_test_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g

export function detectSecretSpans(text: string): Span[] {
  if (!/[A-Za-z]/.test(text)) return []
  const out: Span[] = []
  const prev = SECRET_RE.lastIndex
  SECRET_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = SECRET_RE.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        cls: 'secret',
        token: SECRET,
        source: 'secret',
      })
      if (SECRET_RE.lastIndex === m.index) {
        SECRET_RE.lastIndex = m.index + 1
        if (SECRET_RE.lastIndex > text.length) break
      }
    }
  } finally {
    SECRET_RE.lastIndex = prev
  }
  return out
}
