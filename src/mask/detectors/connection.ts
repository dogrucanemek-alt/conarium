/**
 * Password span inside a scheme://user:password@host string. The scheme and user stay outside.
 * Ranges are the password of each linear match (between group 1 and the closing `@`).
 */
import type { Span } from '../core.js'
import { forEachConnectionCredential } from '../legacy_0254/conn_linear.js'

const SECRET = '[MASKED_SECRET]'

export function detectConnectionSpans(text: string): Span[] {
  if (!text.includes('://')) return []
  const out: Span[] = []
  forEachConnectionCredential(text, (match) => {
    if (match.at > match.group1End) {
      out.push({
        start: match.group1End,
        end: match.at,
        cls: 'connection',
        token: SECRET,
        source: 'connection',
      })
    }
  })
  return out
}
