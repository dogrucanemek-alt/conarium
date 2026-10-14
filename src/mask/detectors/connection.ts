/**
 * Password span inside a scheme://user:password@host string. The scheme and user stay outside.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'
const CONNECTION_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g

export function detectConnectionSpans(text: string): Span[] {
  if (!text.includes('://')) return []
  const out: Span[] = []
  const prev = CONNECTION_RE.lastIndex
  CONNECTION_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = CONNECTION_RE.exec(text)) !== null) {
      if (m[1]) {
        const start = m.index + m[1].length
        const end = m.index + m[0].length - (m[2]?.length ?? 1)
        if (end > start) out.push({ start, end, cls: 'connection', token: SECRET, source: 'connection' })
      }
      if (CONNECTION_RE.lastIndex === m.index) {
        CONNECTION_RE.lastIndex = m.index + 1
        if (CONNECTION_RE.lastIndex > text.length) break
      }
    }
  } finally {
    CONNECTION_RE.lastIndex = prev
  }
  return out
}
