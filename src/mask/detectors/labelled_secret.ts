/**
 * Value after a secret label, up to the first delimiter. The label stays outside the span.
 */
import type { Span } from '../core.js'

const SECRET = '[MASKED_SECRET]'
const LABELLED_RE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi
const HINT = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization/i

export function detectLabelledSecretSpans(text: string): Span[] {
  if (!HINT.test(text)) return []
  const out: Span[] = []
  const prev = LABELLED_RE.lastIndex
  LABELLED_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = LABELLED_RE.exec(text)) !== null) {
      if (m[1]) {
        const start = m.index + m[1].length
        const end = m.index + m[0].length
        if (end > start) out.push({ start, end, cls: 'labelled-secret', token: SECRET, source: 'labelled-secret' })
      }
      if (LABELLED_RE.lastIndex === m.index) {
        LABELLED_RE.lastIndex = m.index + 1
        if (LABELLED_RE.lastIndex > text.length) break
      }
    }
  } finally {
    LABELLED_RE.lastIndex = prev
  }
  return out
}
