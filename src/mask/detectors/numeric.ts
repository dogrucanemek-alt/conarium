/**
 * Phone, TCKN, card, and SSN spans. Formatted phones are found first and split later digit runs.
 */
import { luhnOk } from '../../digit_pii.js'
import { tcknChecksumOk } from '../../tckn.js'
import type { Span, SpanClass } from '../core.js'

const PII = '[MASKED_PII]'
const PHONE_FORMATTED =
  /(?<!\d)(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g
const TR_MOBILE_322 = /(?<!\d)\+90[\s-]5\d{2}[\s-]\d{3}[\s-]\d{2}[\s-]\d{2}(?!\d)/g

type Strength = 'checksummed' | 'shape-only'

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isGroup(c: string): boolean {
  return c === ' ' || c === '-' || c === '.' || c === '/'
}

function isWord(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c)
}

function isolatedSpan(s: string, start: number, end: number, strength: Strength): boolean {
  const left = start === 0 ? '' : s[start - 1]
  const right = end >= s.length ? '' : s[end]
  if (isDigit(left) || isDigit(right)) return false
  if (strength === 'checksummed') return true
  if (right && /[A-Za-z_]/.test(right)) {
    const after = end + 1 < s.length ? s[end + 1] : ''
    if (after && isWord(after)) return false
  }
  return true
}

function looksLikeDottedIpOrVersion(s: string, start: number, end: number): boolean {
  const slice = s.slice(start, end)
  if (!/[./]/.test(slice)) return false
  const groups = slice.split(/[./]/).filter((g) => g.length > 0)
  if (groups.length < 4) return false
  return groups.every((g) => /^\d{1,3}$/.test(g))
}

function collectDigits(s: string, start: number, end: number): string {
  let d = ''
  for (let j = start; j < end; j++) {
    const c = s[j]
    if (isDigit(c)) d += c
  }
  return d
}

function classify(
  s: string,
  start: number,
  end: number,
  n: number,
): { strength: Strength; cls: SpanClass } | null {
  if (n === 10) return { strength: 'shape-only', cls: 'phone' }
  if (n === 9) {
    return /^\d{3}-\d{2}-\d{4}$/.test(s.slice(start, end))
      ? { strength: 'shape-only', cls: 'ssn' }
      : null
  }
  if (n === 11) {
    const digits = collectDigits(s, start, end)
    if (tcknChecksumOk(digits)) return { strength: 'checksummed', cls: 'tckn' }
    if (/^05\d{9}$/.test(digits)) return { strength: 'checksummed', cls: 'phone' }
    const first = s[start]
    if (first === '0') return { strength: 'shape-only', cls: 'phone' }
    if (first >= '1' && first <= '9') return { strength: 'shape-only', cls: 'tckn' }
    return null
  }
  if (n >= 13 && n <= 16) {
    return luhnOk(collectDigits(s, start, end)) ? { strength: 'checksummed', cls: 'card' } : null
  }
  return null
}

interface Group {
  start: number
  end: number
}

function groupsOf(text: string, start: number, end: number): Group[] {
  const groups: Group[] = []
  let j = start
  while (j < end) {
    if (!isDigit(text[j])) {
      j++
      continue
    }
    const gs = j
    while (j < end && isDigit(text[j])) j++
    groups.push({ start: gs, end: j })
  }
  return groups
}

function pushSpan(out: Span[], start: number, end: number, cls: SpanClass): void {
  if (end <= start) return
  out.push({ start, end, cls, token: PII, source: 'numeric' })
}

function findPhones(text: string): Span[] {
  const out: Span[] = []
  if (/[+()\s-]/.test(text) && /\d/.test(text)) {
    const prev = PHONE_FORMATTED.lastIndex
    PHONE_FORMATTED.lastIndex = 0
    try {
      let m: RegExpExecArray | null
      while ((m = PHONE_FORMATTED.exec(text)) !== null) {
        if (!/^\d+$/.test(m[0])) pushSpan(out, m.index, m.index + m[0].length, 'phone')
        if (PHONE_FORMATTED.lastIndex === m.index) {
          PHONE_FORMATTED.lastIndex = m.index + 1
          if (PHONE_FORMATTED.lastIndex > text.length) break
        }
      }
    } finally {
      PHONE_FORMATTED.lastIndex = prev
    }
  }
  if (text.includes('+90')) {
    const prev = TR_MOBILE_322.lastIndex
    TR_MOBILE_322.lastIndex = 0
    try {
      let m: RegExpExecArray | null
      while ((m = TR_MOBILE_322.exec(text)) !== null) {
        pushSpan(out, m.index, m.index + m[0].length, 'phone')
        if (TR_MOBILE_322.lastIndex === m.index) {
          TR_MOBILE_322.lastIndex = m.index + 1
          if (TR_MOBILE_322.lastIndex > text.length) break
        }
      }
    } finally {
      TR_MOBILE_322.lastIndex = prev
    }
  }
  return out
}

export function detectNumericSpans(text: string): Span[] {
  const phones = findPhones(text)
  let mark: Uint8Array | undefined
  if (phones.length > 0) {
    mark = new Uint8Array(text.length)
    for (const p of phones) mark.fill(1, p.start, p.end)
  }
  const blocked = (i: number) => mark !== undefined && mark[i] === 1
  const out = phones.slice()
  let i = 0
  while (i < text.length) {
    if (!isDigit(text[i]) || blocked(i)) {
      i++
      continue
    }
    const start = i
    let n = 0
    while (i < text.length) {
      if (blocked(i)) break
      const c = text[i]
      if (isDigit(c)) {
        n++
        i++
        continue
      }
      if (isGroup(c) && i + 1 < text.length && isDigit(text[i + 1]) && !blocked(i + 1)) {
        i++
        continue
      }
      break
    }
    const runEnd = i
    const found = classify(text, start, runEnd, n)
    const accepted = found !== null
      && !looksLikeDottedIpOrVersion(text, start, runEnd)
      && isolatedSpan(text, start, runEnd, found.strength)
    if (accepted && found) {
      let end = runEnd
      if (found.strength === 'checksummed') {
        while (end < text.length && !blocked(end) && isWord(text[end])) end++
      } else if (end < text.length && !blocked(end) && /[A-Za-z_]/.test(text[end])) {
        const after = end + 1 < text.length ? text[end + 1] : ''
        if (!after || !isWord(after) || blocked(end + 1)) end += 1
      }
      pushSpan(out, start, end, found.cls)
      i = end
      continue
    }
    const groups = groupsOf(text, start, runEnd)
    if (groups.length > 1) {
      for (let a = 0; a < groups.length; a++) {
        let count = 0
        for (let b = a; b < groups.length; b++) {
          count += groups[b].end - groups[b].start
          if (count > 16) break
          if (count !== 11 && (count < 13 || count > 16)) continue
          const wStart = groups[a].start
          const wEnd = groups[b].end
          const win = classify(text, wStart, wEnd, count)
          if (!win || win.strength !== 'checksummed') continue
          if (looksLikeDottedIpOrVersion(text, wStart, wEnd)) continue
          if (!isolatedSpan(text, wStart, wEnd, 'checksummed')) continue
          let spanEnd = wEnd
          if (b === groups.length - 1) {
            while (spanEnd < text.length && !blocked(spanEnd) && isWord(text[spanEnd])) spanEnd++
          }
          pushSpan(out, wStart, spanEnd, win.cls)
        }
      }
    }
  }
  return out
}
