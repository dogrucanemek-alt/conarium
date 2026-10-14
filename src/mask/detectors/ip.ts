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
  const copy = new RegExp(re.source, re.flags)
  for (const m of text.matchAll(copy)) {
    if (m.index === undefined || !ok(m[0])) continue
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      cls: 'ip',
      token: PII,
      source: 'ip',
    })
  }
}

export function detectIpSpans(text: string): Span[] {
  const out: Span[] = []
  if (text.includes(':')) pushValid(text, V6_CANDIDATE, isStrictIpv6, out)
  if (text.includes('.')) pushValid(text, DOTTED_RUN, isStrictIpv4, out)
  return out
}
