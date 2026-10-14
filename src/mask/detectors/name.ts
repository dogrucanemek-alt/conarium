/**
 * Title-marked and label-marked personal names. The title or label stays outside the span.
 */
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
const NAME_SHAPE = String.raw`\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+){0,2}`
const TITLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(Sn\.|Sayın|Sayin|Bayan|Bay|Mrs\.|Mr\.|Ms\.|Dr\.|Av\.|Prof\.)\s+(${NAME_SHAPE})`,
  'gu',
)
const LABELLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(müşteri|musteri|yetkili|kişi|kisi|temsilci|adı soyadı|adi soyadi|ad soyad|customer|contact|full name|name)\s*:\s*(${NAME_SHAPE})`,
  'giu',
)

function pushNames(text: string, re: RegExp, out: Span[]): void {
  const copy = new RegExp(re.source, re.flags)
  for (const m of text.matchAll(copy)) {
    const name = m[2]
    if (m.index === undefined || !name) continue
    const start = m.index + m[0].length - name.length
    out.push({
      start,
      end: start + name.length,
      cls: 'name',
      token: PII,
      source: 'name',
    })
  }
}

export function detectNameSpans(text: string): Span[] {
  if (!/\p{L}/u.test(text)) return []
  const out: Span[] = []
  pushNames(text, TITLED_NAME_RE, out)
  pushNames(text, LABELLED_NAME_RE, out)
  return out
}
