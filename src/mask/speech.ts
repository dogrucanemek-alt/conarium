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
const TLD = new Set(['com', 'net', 'org', 'edu', 'gov', 'io', 'ai', 'tr'])
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
  if (sep !== '-' && sep !== '.') return false
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

function hyphenSeps(text: string, start: number, end: number): number {
  let n = 0
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) === 45) n++
  }
  return n
}

/** 7+ digits, or a 6-digit run split by 3 or more hyphens (ASR IBAN tail). */
function longEnoughRun(digits: number, text: string, start: number, end: number): boolean {
  if (digits >= 7) return true
  return digits === 6 && hyphenSeps(text, start, end) >= 3
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
    if (!longEnoughRun(run.digits.length, text, start, end)) continue
    if (!isolatedRun(text, start, end)) continue
    if (isDateRun(text.slice(start, end))) continue
    const cls = classifyDigits(run.digits, text.slice(start, end))
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
    if (!run) {
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

function isNoktaChain(words: readonly Word[], from: number, to: number, text: string): boolean {
  const n = to - from + 1
  if (n < 1 || n % 2 === 0) return false
  for (let k = from; k <= to; k++) {
    if (k > from && !singleSpace(text, words[k - 1].end, words[k].start)) return false
    if ((k - from) % 2 === 1 && words[k].lower !== 'nokta') return false
  }
  return true
}

function tldChain(words: readonly Word[], from: number, to: number): boolean {
  const last = words[to]
  if ((to - from) % 2 !== 0) return false
  return TLD.has(last.lower)
}

function findSpokenEmails(text: string, classified: Span[]): void {
  const words = collectWords(text)
  for (let e = 0; e < words.length; e++) {
    const mark = words[e].lower
    if (mark !== 'et' && mark !== 'at') continue
    if (e === 0 || e + 1 >= words.length) continue
    if (!singleSpace(text, words[e - 1].end, words[e].start)) continue
    if (!singleSpace(text, words[e].end, words[e + 1].start)) continue

    let left = -1
    for (let s = 0; s < e; s++) {
      if (isNoktaChain(words, s, e - 1, text)) {
        left = s
        break
      }
    }
    if (left < 0) continue

    let right = -1
    for (let t = e + 3; t < words.length; t += 2) {
      if (!isNoktaChain(words, e + 1, t, text)) break
      if (tldChain(words, e + 1, t)) right = t
    }
    if (right < 0) continue
    pushClassified(classified, words[left].start, words[right].end, 'email')
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
    if (
      labels.length >= 4
      && lettersOnly(labels[0].raw)
      && lettersOnly(labels[1].raw)
      && TLD.has(labels[labels.length - 1].lower)
      && (end === text.length || !isLabelChar(text[end]))
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
