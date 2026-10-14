/**
 * Bearer token span. The "Bearer " prefix stays outside the span.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi

export function detectBearerSpans(text: string): Span[] {
  if (!/bearer/i.test(text)) return []
  const out: Span[] = []
  const re = new RegExp(BEARER_RE.source, BEARER_RE.flags)
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || !m[1]) continue
    const start = m.index + m[1].length
    const end = m.index + m[0].length
    if (end <= start) continue
    out.push({ start, end, cls: 'bearer', token: SECRET, source: 'bearer' })
  }
  return out
}
