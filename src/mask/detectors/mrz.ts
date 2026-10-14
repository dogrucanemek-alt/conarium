/**
 * ICAO TD3 passport spans. A checksum failure is not a span.
 */
import { isTd3Mrz } from '../../mrz.js'
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
const TD3_BLOCK = /P[A-Z0-9<]{43}(?:\r?\n)[A-Z0-9<]{44}/g

export function detectMrzSpans(text: string): Span[] {
  if (!text.includes('\n')) return []
  const out: Span[] = []
  const re = new RegExp(TD3_BLOCK.source, TD3_BLOCK.flags)
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue
    const block = m[0]
    const nl = block.includes('\r\n') ? '\r\n' : '\n'
    const i = block.indexOf(nl)
    const line1 = block.slice(0, i)
    const line2 = block.slice(i + nl.length)
    if (!isTd3Mrz(line1, line2)) continue
    out.push({
      start: m.index,
      end: m.index + block.length,
      cls: 'mrz',
      token: PII,
      source: 'mrz',
    })
  }
  return out
}
