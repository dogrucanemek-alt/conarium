/**
 * Password span inside a scheme://user:password@host string. The scheme and user stay outside.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'
const CONNECTION_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g

export function detectConnectionSpans(text: string): Span[] {
  if (!text.includes('://')) return []
  const out: Span[] = []
  const re = new RegExp(CONNECTION_RE.source, CONNECTION_RE.flags)
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || !m[1]) continue
    const start = m.index + m[1].length
    const end = m.index + m[0].length - (m[2]?.length ?? 1)
    if (end <= start) continue
    out.push({ start, end, cls: 'connection', token: SECRET, source: 'connection' })
  }
  return out
}
