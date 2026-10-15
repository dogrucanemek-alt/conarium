/**
 * Bearer token span. The "Bearer " prefix stays outside the span.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi

export function detectBearerSpans(text: string): Span[] {
  if (!/bearer/i.test(text)) return []
  const out: Span[] = []
  const prev = BEARER_RE.lastIndex
  BEARER_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = BEARER_RE.exec(text)) !== null) {
      if (m[1]) {
        const start = m.index + m[1].length
        const end = m.index + m[0].length
        if (end > start) out.push({ start, end, cls: 'bearer', token: SECRET, source: 'bearer' })
      }
      if (BEARER_RE.lastIndex === m.index) {
        BEARER_RE.lastIndex = m.index + 1
        if (BEARER_RE.lastIndex > text.length) break
      }
    }
  } finally {
    BEARER_RE.lastIndex = prev
  }
  return out
}
