/**
 * Title-marked and label-marked personal names. The title or label stays outside the span.
 */
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
/** Horizontal space only: a line break is not a name-word separator. */
const HORIZ = String.raw`[^\S\r\n]`
const NAME_SHAPE = String.raw`\p{Lu}\p{L}+(?:${HORIZ}+\p{Lu}\p{L}+){0,2}`
const TITLE = String.raw`Sn\.|Sayın|Sayin|Bayan|Bay|Mrs\.|Mr\.|Ms\.|Dr\.|Av\.|Prof\.`
const TITLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?:${TITLE})${HORIZ}+)+(${NAME_SHAPE})`,
  'gu',
)
const LABEL_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(müşteri|musteri|yetkili|kişi|kisi|temsilci|adı soyadı|adi soyadi|ad soyad|customer|contact|full name|name)${HORIZ}*:`,
  'giu',
)
const NAME_AFTER_LABEL = new RegExp(String.raw`^${HORIZ}*(${NAME_SHAPE})`, 'u')

function pushNames(text: string, re: RegExp, out: Span[]): void {
  const prev = re.lastIndex
  re.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const name = m[m.length - 1]
      if (name) {
        const start = m.index + m[0].length - name.length
        out.push({
          start,
          end: start + name.length,
          cls: 'name',
          token: PII,
          source: 'name',
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

function pushLabelledNames(text: string, out: Span[]): void {
  const prev = LABEL_RE.lastIndex
  LABEL_RE.lastIndex = 0
  try {
    let m: RegExpExecArray | null
    while ((m = LABEL_RE.exec(text)) !== null) {
      const after = m.index + m[0].length
      const found = NAME_AFTER_LABEL.exec(text.slice(after))
      const name = found?.[1]
      if (name) {
        const start = after + found[0].length - name.length
        out.push({
          start,
          end: start + name.length,
          cls: 'name',
          token: PII,
          source: 'name',
        })
      }
      if (LABEL_RE.lastIndex === m.index) {
        LABEL_RE.lastIndex = m.index + 1
        if (LABEL_RE.lastIndex > text.length) break
      }
    }
  } finally {
    LABEL_RE.lastIndex = prev
  }
}

export function detectNameSpans(text: string): Span[] {
  if (!/\p{L}/u.test(text)) return []
  const out: Span[] = []
  pushNames(text, TITLED_NAME_RE, out)
  pushLabelledNames(text, out)
  return out
}
