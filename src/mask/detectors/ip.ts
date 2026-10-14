/**
 * Strict IPv4 and IPv6 spans. Callers enable this detector explicitly.
 */
import { isStrictIpv4, isStrictIpv6 } from '../../ip_detect.js'
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
const DOTTED_RUN = /(?<![\d.])(?:\d{1,3}\.)+\d{1,3}(?![\d.])/g
const V6_CANDIDATE =
  /(?<![0-9A-Fa-f:])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:\.(?:0|[1-9]\d{0,2})){0,3}\]?(?![0-9A-Fa-f:])/g

function pushValid(
  text: string,
  re: RegExp,
  ok: (s: string) => boolean,
  out: Span[],
): void {
  const prev = re.lastIndex
  re.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (ok(m[0])) {
        out.push({
          start: m.index,
          end: m.index + m[0].length,
          cls: 'ip',
          token: PII,
          source: 'ip',
        })
      }
      if (re.lastIndex === m.index) {
        re.lastIndex = m.index + 1
        if (re.lastIndex > text.length) break
      }
    }
  } finally {
    re.lastIndex = prev
  }
}

export function detectIpSpans(text: string): Span[] {
  const out: Span[] = []
  if (text.includes(':')) pushValid(text, V6_CANDIDATE, isStrictIpv6, out)
  if (text.includes('.')) pushValid(text, DOTTED_RUN, isStrictIpv4, out)
  return out
}
