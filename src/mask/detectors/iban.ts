/**
 * Checksum-valid IBAN spans. An IBAN-shaped word that fails mod-97 is not a span.
 *
 * A start is a letter pair whose country code is in `IBAN_LENGTHS`: a
 * word-initial pair, or a pair glued inside a word with its check digits
 * right after it (`acctTR33…`). A pair inside a word with a separator before
 * the digits (`numaram 29…`) is the end of a word, not a country code. The
 * candidate is exactly that country's length in alphanumerics, and it ends
 * where a word or a digit run ends, or where its digits meet letters
 * (`…3000ABC`); it never ends inside a word or a digit run. A hit is not
 * consumed. The next search begins one character later, so a later valid
 * IBAN that overlaps the first is still returned. apply merges overlaps.
 */
import { ibanMod97Ok, looksLikeIban, normalizeIban } from '../../iban.js'
import type { Span } from '../core.js'
import { IBAN_LENGTHS } from './iban_lengths.js'

const PII = '[MASKED_PII]'
const ANCHOR_SRC = /[A-Za-z]{2}[\s-]*\d{2}/g

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9]/.test(c)
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isSep(c: string): boolean {
  return /[\s-]/.test(c)
}

/** End index of the first `count` alphanumerics from `start`, separators allowed between them; -1 when the run is shorter. */
function endAfter(s: string, start: number, count: number): number {
  let i = start
  let alnum = 0
  while (i < s.length) {
    if (isAlnum(s[i])) {
      alnum++
      i++
      if (alnum === count) return i
      continue
    }
    if (isSep(s[i])) {
      let j = i
      while (j < s.length && isSep(s[j])) j++
      if (isAlnum(s[j])) {
        i = j
        continue
      }
    }
    break
  }
  return -1
}

function endsCleanly(s: string, end: number): boolean {
  if (!isAlnum(s[end])) return true
  return isDigit(s[end - 1]) && !isDigit(s[end])
}

function validAt(text: string, at: number): number {
  const glued = isAlnum(text[at - 1])
  if (glued && !isDigit(text[at + 2])) return -1
  const lengths = IBAN_LENGTHS[text.slice(at, at + 2).toUpperCase()]
  if (!lengths) return -1
  for (let k = lengths.length - 1; k >= 0; k--) {
    const end = endAfter(text, at, lengths[k])
    if (end < 0 || !endsCleanly(text, end)) continue
    const normalized = normalizeIban(text.slice(at, end))
    if (looksLikeIban(normalized) && ibanMod97Ok(normalized)) return end
  }
  return -1
}

export function detectIbanSpans(text: string): Span[] {
  if (!/[A-Za-z]{2}/.test(text) || !/\d{2}/.test(text)) return []
  const out: Span[] = []
  const prev = ANCHOR_SRC.lastIndex
  ANCHOR_SRC.lastIndex = 0
  try {
    let anchor: RegExpExecArray | null
    while ((anchor = ANCHOR_SRC.exec(text)) !== null) {
      const at = anchor.index
      const end = validAt(text, at)
      if (end > at) {
        out.push({
          start: at,
          end,
          cls: 'iban',
          token: PII,
          source: 'iban',
        })
      }
      const next = at + 1
      if (next > text.length) break
      ANCHOR_SRC.lastIndex = next
    }
  } finally {
    ANCHOR_SRC.lastIndex = prev
  }
  return out
}
