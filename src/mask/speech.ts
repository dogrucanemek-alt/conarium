/**
 * Speech-pipeline spans: digits a local model split with spaces or hyphens,
 * TR plus such a run, and addresses said with et/at and nokta or written
 * as four or more dotted labels. Called only when pipeline is `speech`.
 * Every walk is linear; no open-ended backtracking.
 */
import { luhnOk } from '../digit_pii.js'
import { tcknChecksumOk } from '../tckn.js'
import type { Span, SpanClass } from './core.js'
import { detectNumericSpans } from './detectors/numeric.js'

const PII = '[MASKED_PII]'
// Shared by the spoken `et`/`at`+`nokta` rule and the dotted-label rule.
// An address whose last label is not in this list is not masked by either.
// `at` is omitted: it is also the spoken `@`.
const DOMAIN_ENDINGS = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'info',
  'biz',
  'io',
  'ai',
  'app',
  'dev',
  'co',
  'me',
  'tv',
  'xyz',
  'online',
  'site',
  'tech',
  'cloud',
  'email',
  'tr',
  'uk',
  'de',
  'fr',
  'nl',
  'it',
  'es',
  'eu',
  'us',
  'ca',
  'au',
  'ch',
  'be',
  'se',
  'no',
  'dk',
  'fi',
  'pl',
  'ru',
  'az',
  'cy',
])
// Endings that are also Turkish words (`biz` is "we"). A spoken nokta
// chain reads one only when no other listed ending is on that chain; a
// dotted run reads it as any other ending.
const WORD_ENDINGS = new Set(['biz'])
// Mailbox providers a speech model glues a spoken `et` / `at` onto:
// `ali et gmail nokta com` comes out as `ali.etgmail.com`.
const FUSED_PROVIDERS = new Set(['gmail', 'hotmail', 'outlook', 'yahoo', 'icloud', 'yandex', 'protonmail', 'live'])
const SCHEMES = new Set(['http', 'https', 'ftp', 'mailto', 'file'])
const MAX_LABELS = 32

export interface SpeechHit {
  classified: Span[]
  unclassified: { start: number; end: number }[]
}

interface Word {
  start: number
  end: number
  lower: string
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && /\p{L}/u.test(c)
}

function isLabelChar(c: string | undefined): boolean {
  if (c === undefined) return false
  if (isLetter(c) || isDigit(c)) return true
  return c === '-'
}

function lettersOnly(s: string): boolean {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    if (!isLetter(s[i])) return false
  }
  return true
}

/** Ending lookup only: U+0130 lowercases to `i` + U+0307, which misses `ai`. */
function endingKey(s: string): string {
  const lower = s.toLowerCase()
  let out = ''
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]
    if (c === '\u0307') continue
    out += c === '\u0131' ? 'i' : c
  }
  return out
}

function isDomainEnding(s: string): boolean {
  return DOMAIN_ENDINGS.has(endingKey(s))
}

function isFusedProvider(s: string): boolean {
  const key = endingKey(s)
  return (key.startsWith('et') || key.startsWith('at')) && FUSED_PROVIDERS.has(key.slice(2))
}

function isolatedRun(text: string, start: number, end: number): boolean {
  const left = start === 0 ? '' : text[start - 1]
  const right = end >= text.length ? '' : text[end]
  if (isDigit(left) || isDigit(right)) return false
  if (isLetter(left) || isLetter(right)) return false
  return true
}

function isDateRun(raw: string): boolean {
  if (raw.length < 8 || raw.length > 10) return false
  let i = 0
  let day = 0
  let n = 0
  while (i < raw.length && isDigit(raw[i]) && n < 2) {
    day = day * 10 + (raw.charCodeAt(i) - 48)
    i++
    n++
  }
  if (n === 0 || i >= raw.length) return false
  const sep = raw[i]
  if (sep !== '-' && sep !== '.' && sep !== ' ') return false
  i++
  let month = 0
  n = 0
  while (i < raw.length && isDigit(raw[i]) && n < 2) {
    month = month * 10 + (raw.charCodeAt(i) - 48)
    i++
    n++
  }
  if (n === 0 || raw[i] !== sep) return false
  i++
  n = 0
  while (i < raw.length && isDigit(raw[i])) {
    n++
    i++
  }
  if (n !== 4 || i !== raw.length) return false
  return day >= 1 && day <= 31 && month >= 1 && month <= 12
}

function yearValue(raw: string, from: number): number | null {
  if (from + 4 > raw.length) return null
  let y = 0
  for (let k = 0; k < 4; k++) {
    const c = raw[from + k]
    if (!isDigit(c)) return null
    y = y * 10 + (c.charCodeAt(0) - 48)
  }
  if (y < 1900 || y > 2099) return null
  return y
}

/** Exactly two 4-digit years 1900–2099 joined by one space or one hyphen. */
function isYearRange(raw: string): boolean {
  if (raw.length !== 9) return false
  const sep = raw[4]
  if (sep !== '-' && sep !== ' ') return false
  return yearValue(raw, 0) !== null && yearValue(raw, 5) !== null
}

function readDigitRun(text: string, start: number): { end: number; digits: string } | null {
  if (!isDigit(text[start])) return null
  let i = start
  let digits = ''
  while (i < text.length) {
    const c = text[i]
    if (isDigit(c)) {
      digits += c
      i++
      continue
    }
    if ((c === ' ' || c === '-') && i + 1 < text.length && isDigit(text[i + 1])) {
      i++
      continue
    }
    break
  }
  return { end: i, digits }
}

function classifyDigits(digits: string, runText: string): SpanClass | null {
  if (digits.length === 11 && tcknChecksumOk(digits)) return 'tckn'
  if (detectNumericSpans(runText).some((sp) => sp.cls === 'phone')) return 'phone'
  if (digits.length === 10) return 'phone'
  if (digits.length === 11 && digits.charCodeAt(0) === 48) return 'phone'
  if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) return 'card'
  return null
}

function pushClassified(out: Span[], start: number, end: number, cls: SpanClass): void {
  if (end <= start) return
  out.push({ start, end, cls, token: PII, source: 'speech' })
}

function findDigitRuns(text: string, classified: Span[], unclassified: { start: number; end: number }[]): void {
  let i = 0
  while (i < text.length) {
    if (!isDigit(text[i])) {
      i++
      continue
    }
    const run = readDigitRun(text, i)
    if (!run) {
      i++
      continue
    }
    const start = i
    const end = run.end
    i = end
    if (run.digits.length < 7) continue
    if (!isolatedRun(text, start, end)) continue
    const raw = text.slice(start, end)
    if (isDateRun(raw) || isYearRange(raw)) continue
    const cls = classifyDigits(run.digits, raw)
    if (cls) pushClassified(classified, start, end, cls)
    else unclassified.push({ start, end })
  }
}

function findIbans(text: string, classified: Span[]): void {
  let i = 0
  while (i < text.length) {
    const a = text[i]
    const b = text[i + 1]
    if ((a !== 'T' && a !== 't') || (b !== 'R' && b !== 'r')) {
      i++
      continue
    }
    if (i > 0 && isLetter(text[i - 1])) {
      i++
      continue
    }
    let j = i + 2
    if (j < text.length && (text[j] === ' ' || text[j] === '-') && j + 1 < text.length && isDigit(text[j + 1])) {
      j++
    }
    const run = readDigitRun(text, j)
    if (!run || run.digits.length < 4) {
      i++
      continue
    }
    pushClassified(classified, i, run.end, 'iban')
    i = run.end
  }
}

function collectWords(text: string): Word[] {
  const out: Word[] = []
  let i = 0
  while (i < text.length) {
    if (!isLetter(text[i])) {
      i++
      continue
    }
    const start = i
    while (i < text.length && isLetter(text[i])) i++
    out.push({ start, end: i, lower: text.slice(start, i).toLowerCase() })
  }
  return out
}

function singleSpace(text: string, from: number, to: number): boolean {
  return to === from + 1 && text.charCodeAt(from) === 32
}

function noktaLink(words: readonly Word[], text: string, left: number, right: number): boolean {
  if (right !== left + 2) return false
  const mid = words[left + 1]
  return (
    mid.lower === 'nokta'
    && singleSpace(text, words[left].end, mid.start)
    && singleSpace(text, mid.end, words[right].start)
  )
}

/**
 * For each word, how far a nokta chain extends left and right, plus the
 * rightmost TLD that sits on that right-hand chain, and separately the
 * rightmost one of `WORD_ENDINGS`. Built in two linear passes so each
 * `et` / `at` is then a constant-time lookup.
 */
function noktaExtents(words: readonly Word[], text: string): {
  leftExtent: number[]
  rightExtent: number[]
  rightmostTld: number[]
  rightmostWordTld: number[]
} {
  const n = words.length
  const leftExtent = new Array<number>(n)
  const rightExtent = new Array<number>(n)
  const rightmostTld = new Array<number>(n)
  const rightmostWordTld = new Array<number>(n)

  for (let i = 0; i < n; i++) {
    leftExtent[i] = i >= 2 && noktaLink(words, text, i - 2, i) ? leftExtent[i - 2] : i
  }

  for (let i = n - 1; i >= 0; i--) {
    const key = endingKey(words[i].lower)
    const word = WORD_ENDINGS.has(key) ? i : -1
    const tld = word < 0 && DOMAIN_ENDINGS.has(key) ? i : -1
    if (i + 2 < n && noktaLink(words, text, i, i + 2)) {
      rightExtent[i] = rightExtent[i + 2]
      const further = rightmostTld[i + 2]
      rightmostTld[i] = further >= 0 ? further : tld
      const furtherWord = rightmostWordTld[i + 2]
      rightmostWordTld[i] = furtherWord >= 0 ? furtherWord : word
    } else {
      rightExtent[i] = i
      rightmostTld[i] = tld
      rightmostWordTld[i] = word
    }
  }

  return { leftExtent, rightExtent, rightmostTld, rightmostWordTld }
}

/**
 * For each word, the start of the dotted run it sits in, and, when the
 * word begins a dotted run of two or more labels whose last is a listed
 * ending, that run's end. One left-to-right pass so each `et` / `at`
 * then reads these in constant time.
 */
function dottedExtents(words: readonly Word[], text: string): {
  runStart: number[]
  endingEnd: number[]
} {
  const n = words.length
  const runStart = new Array<number>(n)
  const endingEnd = new Array<number>(n)
  for (let w = 0; w < n; w++) {
    runStart[w] = words[w].start
    endingEnd[w] = -1
  }

  let i = 0
  let wi = 0
  while (i < text.length) {
    if (!isLetter(text[i]) && !isDigit(text[i])) {
      i++
      continue
    }
    if (i > 0 && isLabelChar(text[i - 1])) {
      i++
      continue
    }
    const parsed = parseDotted(text, i)
    if (!parsed) {
      i++
      continue
    }
    const { labels, end } = parsed
    while (wi < n && words[wi].start < i) wi++
    const first = wi
    while (wi < n && words[wi].start < end) {
      runStart[wi] = i
      wi++
    }
    if (
      first < n
      && words[first].start === i
      && labels.length >= 2
      && isDomainEnding(labels[labels.length - 1].lower)
      && (end === text.length || !isLabelChar(text[end]))
    ) {
      endingEnd[first] = end
    }
    i = end
  }
  return { runStart, endingEnd }
}

function findSpokenEmails(text: string, classified: Span[]): void {
  const words = collectWords(text)
  if (words.length === 0) return
  const { leftExtent, rightExtent, rightmostTld, rightmostWordTld } = noktaExtents(words, text)
  const { runStart, endingEnd } = dottedExtents(words, text)

  for (let e = 0; e < words.length; e++) {
    const mark = words[e].lower
    if (mark !== 'et' && mark !== 'at') continue
    if (e === 0 || e + 1 >= words.length) continue
    if (!singleSpace(text, words[e - 1].end, words[e].start)) continue
    if (!singleSpace(text, words[e].end, words[e + 1].start)) continue

    const left = leftExtent[e - 1]
    const start = runStart[left]
    const tld = rightmostTld[e + 1]
    const spokenRight = tld >= e + 3 ? tld : rightmostWordTld[e + 1]
    if (spokenRight >= e + 3 && spokenRight <= rightExtent[e + 1]) {
      pushClassified(classified, start, words[spokenRight].end, 'email')
      continue
    }
    const dottedEnd = endingEnd[e + 1]
    if (dottedEnd > words[e + 1].start) {
      pushClassified(classified, start, dottedEnd, 'email')
    }
  }
}

interface Label {
  start: number
  end: number
  raw: string
  lower: string
}

function parseDotted(text: string, start: number): { end: number; labels: Label[] } | null {
  const labels: Label[] = []
  let i = start
  while (labels.length < MAX_LABELS && i < text.length) {
    if (!isLetter(text[i]) && !isDigit(text[i])) break
    const ls = i
    while (i < text.length && isLabelChar(text[i])) i++
    if (i === ls) break
    const raw = text.slice(ls, i)
    labels.push({ start: ls, end: i, raw, lower: raw.toLowerCase() })
    if (text[i] !== '.') break
    i++
  }
  if (labels.length === 0) return null
  return { end: labels[labels.length - 1].end, labels }
}

function findDottedEmails(text: string, classified: Span[]): void {
  let i = 0
  while (i < text.length) {
    if (!isLetter(text[i]) && !isDigit(text[i])) {
      i++
      continue
    }
    if (i > 0 && isLabelChar(text[i - 1])) {
      i++
      continue
    }
    const parsed = parseDotted(text, i)
    if (!parsed) {
      i++
      continue
    }
    const { labels, end } = parsed
    const first = labels[0]
    if (first.lower === 'www' || SCHEMES.has(first.lower) || (i >= 3 && text.slice(i - 3, i) === '://')) {
      i = end
      continue
    }
    const ending = isDomainEnding(labels[labels.length - 1].lower) && (end === text.length || !isLabelChar(text[end]))
    const fused = labels.length >= 3 && labels.slice(1, -1).some((l) => isFusedProvider(l.lower))
    if (
      ending
      && ((labels.length >= 4 && lettersOnly(labels[0].raw) && lettersOnly(labels[1].raw)) || fused)
    ) {
      pushClassified(classified, first.start, end, 'email')
      i = end
      continue
    }
    i = end
  }
}

export function detectSpeechSpans(text: string): SpeechHit {
  const classified: Span[] = []
  const unclassified: { start: number; end: number }[] = []
  if (text.length === 0) return { classified, unclassified }
  findDigitRuns(text, classified, unclassified)
  findIbans(text, classified)
  findSpokenEmails(text, classified)
  findDottedEmails(text, classified)
  return { classified, unclassified }
}
