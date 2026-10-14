/**
 * Checksum-valid IBAN spans. An IBAN-shaped word that fails mod-97 is not a span.
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
  const anchorRe = new RegExp(ANCHOR_SRC.source, ANCHOR_SRC.flags)
  let cursor = 0
  let anchor: RegExpExecArray | null
  while ((anchor = anchorRe.exec(text)) !== null) {
    if (anchor.index < cursor) {
      anchorRe.lastIndex = cursor
      continue
    }
    const run = runFrom(text, anchor.index)
    if (run.length < 15) {
      anchorRe.lastIndex = anchor.index + 1
      continue
    }
    const valid = longestValid(run)
    if (!valid) {
      anchorRe.lastIndex = anchor.index + 1
      continue
    }
    out.push({
      start: anchor.index,
      end: anchor.index + valid.length,
      cls: 'iban',
      token: PII,
      source: 'iban',
    })
    cursor = anchor.index + valid.length
    anchorRe.lastIndex = cursor
  }
  return out
}
