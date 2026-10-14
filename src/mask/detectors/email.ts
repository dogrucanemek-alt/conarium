/**
 * Email spans and entity-encoded email spans on the original text.
 */
import { EMAIL_RE } from '../../digit_pii.js'
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'

const ENCODED_AT = String.raw`(?:&#0*64;|&#x0*40;|&commat;|\\u0040|%40)`
const ENTITY_EMAIL = new RegExp(
  `[a-zA-Z0-9._%+-]{1,64}${ENCODED_AT}[a-zA-Z0-9.-]{1,253}\\.[a-zA-Z]{2,24}`,
  'gi',
)
const ENCODED_AT_HINT = /&#0*64;|&#x0*40;|&commat;|\\u0040|%40/i

function pushMatches(text: string, re: RegExp, cls: Span['cls'], source: string, out: Span[]): void {
  const prev = re.lastIndex
  re.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        cls,
        token: PII,
        source,
      })
      if (re.lastIndex === m.index) {
        re.lastIndex = m.index + 1
        if (re.lastIndex > text.length) break
      }
    }
  } finally {
    re.lastIndex = prev
  }
}

export function detectEmailSpans(text: string): Span[] {
  const out: Span[] = []
  if (text.includes('@')) pushMatches(text, EMAIL_RE, 'email', 'email', out)
  if (ENCODED_AT_HINT.test(text)) pushMatches(text, ENTITY_EMAIL, 'entity-email', 'entity-email', out)
  return out
}
