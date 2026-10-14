/**
 * Checksum-valid IBAN spans. An IBAN-shaped word that fails mod-97 is not a span.
 *
 * Every letter-pair anchor is a start: a word-initial pair, or the same pair
 * glued inside a word. A hit is not consumed. The next search begins one
 * character later, so a later valid IBAN that overlaps the first is still
 * returned. apply merges overlaps. Each start reads at most 34 alphanumerics.
 */
import { ibanMod97Ok, looksLikeIban, normalizeIban } from '../../iban.js'
import type { Span } from '../core.js'

const PII = '[MASKED_PII]'
const ANCHOR_SRC = /[A-Za-z]{2}[\s-]*\d{2}/g

function isAlnum(c: string): boolean {
  return /[A-Za-z0-9]/.test(c)
}

function isSep(c: string): boolean {
  return /[\s-]/.test(c)
}

function runFrom(s: string, start: number): string {
  let i = start
  let alnum = 0
  let end = start
  while (i < s.length && alnum < 34) {
    if (isAlnum(s[i])) {
      alnum++
      i++
      end = i
      continue
    }
    if (isSep(s[i])) {
      let j = i
      while (j < s.length && isSep(s[j])) j++
      if (j < s.length && isAlnum(s[j]) && alnum < 34) {
        i = j
        continue
      }
    }
    break
  }
  return s.slice(start, end)
}

function trimTrailingIbanChar(s: string): string {
  return s.replace(/[\s-]*[A-Za-z0-9]$/i, '')
}

function longestValid(raw: string): string | null {
  let candidate = raw
  while (candidate.length >= 15) {
    const normalized = normalizeIban(candidate)
    if (looksLikeIban(normalized) && ibanMod97Ok(normalized)) return candidate
    const next = trimTrailingIbanChar(candidate)
    if (next === candidate) break
    candidate = next
  }
  return null
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
      const run = runFrom(text, at)
      if (run.length >= 15) {
        const valid = longestValid(run)
        if (valid) {
          out.push({
            start: at,
            end: at + valid.length,
            cls: 'iban',
            token: PII,
            source: 'iban',
          })
        }
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
