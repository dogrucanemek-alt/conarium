/**
 * User-defined PII patterns from config.
 *
 * Same response-path scanner as the built-in detectors — not a second masker.
 * The pattern text is treated as sensitive: errors, logs and receipts carry
 * the rule NAME only.
 *
 * User regex is ReDoS-risky. This module never runs an unbounded pattern:
 * nested / overlapping quantifiers, `+` / `*`, open `{n,}` and lookaround
 * are rejected at compile. A broken rule fails the config (silent drop = leak).
 */
import type { CustomPiiPattern } from './types.js'

export const CUSTOM_PATTERN_MAX_SOURCE = 200
export const CUSTOM_PATTERN_MAX_QUANTIFIER = 64
export const CUSTOM_PATTERN_MAX_MATCHES = 256

export type CustomPatternReject =
  | 'invalid'
  | 'unsafe'
  | 'duplicate'
  | 'empty'
  | 'too-long'
  | 'bad-name'
  | 'bad-label'

const REJECT_MESSAGE: Record<CustomPatternReject, (name: string) => string> = {
  invalid: (name) => `customPatterns: rule "${name}" is not a valid regular expression`,
  unsafe: (name) => `customPatterns: rule "${name}" was rejected (unbounded or nested quantifiers)`,
  duplicate: (name) => `customPatterns: rule name "${name}" is duplicated`,
  empty: (name) => `customPatterns: rule "${name}" has an empty pattern`,
  'too-long': (name) => `customPatterns: rule "${name}" exceeds the pattern length cap`,
  'bad-name': (name) => `customPatterns: rule name "${name}" is not allowed`,
  'bad-label': (name) => `customPatterns: rule "${name}" has an invalid mask label`,
}

export class CustomPatternError extends Error {
  readonly ruleName: string
  readonly reason: CustomPatternReject

  constructor(ruleName: string, reason: CustomPatternReject) {
    const shown = ruleName.length > 64 ? `${ruleName.slice(0, 64)}…` : ruleName
    super(REJECT_MESSAGE[reason](shown))
    this.name = 'CustomPatternError'
    this.ruleName = shown
    this.reason = reason
  }
}

export interface CompiledCustomPattern {
  name: string
  columns: string[]
  label: string
  /** Source kept only in memory for lastIndex-safe clones. Never logged. */
  re: RegExp
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const LABEL_RE = /^\[[A-Za-z][A-Za-z0-9._-]{0,61}\]$/

export function compileCustomPatterns(
  list: CustomPiiPattern[] | undefined,
): CompiledCustomPattern[] {
  if (!list || list.length === 0) return []
  const seen = new Set<string>()
  return list.map((item) => {
    if (!NAME_RE.test(item.name)) throw new CustomPatternError(item.name || 'unnamed', 'bad-name')
    const key = item.name.toLowerCase()
    if (seen.has(key)) throw new CustomPatternError(item.name, 'duplicate')
    seen.add(key)
    return compileOne(item)
  })
}

function compileOne(item: CustomPiiPattern): CompiledCustomPattern {
  const source = item.pattern
  if (typeof source !== 'string' || source.length === 0) {
    throw new CustomPatternError(item.name, 'empty')
  }
  if (source.length > CUSTOM_PATTERN_MAX_SOURCE) {
    throw new CustomPatternError(item.name, 'too-long')
  }
  if (looksUnsafe(source)) {
    throw new CustomPatternError(item.name, 'unsafe')
  }

  const label = item.label ?? '[MASKED_PII]'
  if (!LABEL_RE.test(label)) {
    throw new CustomPatternError(item.name, 'bad-label')
  }

  let re: RegExp
  try {
    re = new RegExp(source, 'gu')
  } catch {
    // SyntaxError text includes the pattern. Drop it.
    throw new CustomPatternError(item.name, 'invalid')
  }

  return {
    name: item.name,
    columns: (item.columns ?? []).filter(Boolean),
    label,
    re,
  }
}

/**
 * Conservative static reject. Linear class quantifiers (`[0-9]{8}`) pass.
 * Anything that can explode backtracking — or is simply unbounded — does not.
 *
 * A quantified group (nested included) that contains `|` is rejected: `|`
 * is tracked on the group stack the same way a quantifier is. Two
 * variable-width quantifiers (`?`, `{lo,hi}` with hi>lo) with no other
 * consuming atom between them are rejected when their character sets are
 * the same or overlap. Disjoint sets (`-?[0-9]{5,8}`) stay.
 */
export function looksUnsafe(source: string): boolean {
  if (/\(\?[=!<]/.test(source)) return true
  if (/\\[1-9]/.test(source)) return true
  if (/[+*]/.test(source)) return true
  if (/\{\d+,\}/.test(source)) return true
  if (/\([^)]*[+*{][^)]*\)[+*{?]/.test(source)) return true
  if (/\([^)]*\|[^)]*\)[+*{]/.test(source)) return true
  if (/\([^)]*\)[+*]/.test(source)) return true
  if (quantifiedGroupContainsQuantifier(source)) return true

  for (const m of source.matchAll(/\{(\d+)(?:,(\d+))?\}/g)) {
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return true
    if (hi < lo) return true
    if (hi > CUSTOM_PATTERN_MAX_QUANTIFIER) return true
    if (hi - lo > CUSTOM_PATTERN_MAX_QUANTIFIER) return true
  }
  if (adjacentVariableOverlap(source)) return true
  return false
}

/**
 * A group that already holds a quantifier (`?`, `{…}`, `+`, `*`) and is
 * itself quantified explodes on backtracking: `(?:a?){n}`. The `?` that
 * opens `(?:`, `(?=`, `(?!`, `(?<name>`, `(?<=`, `(?<!` is group syntax.
 */
function quantifiedGroupContainsQuantifier(source: string): boolean {
  const stack: boolean[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      i = skipCharClass(source, i)
      continue
    }
    if (ch === '(') {
      stack.push(false)
      i = skipGroupHead(source, i + 1)
      continue
    }
    if (ch === ')') {
      const holds = stack.pop() ?? false
      i++
      const q = quantifierLength(source, i)
      if (q > 0 && holds) return true
      if (q > 0) i += q
      if ((q > 0 || holds) && stack.length > 0) stack[stack.length - 1] = true
      continue
    }
    if (ch === '|') {
      if (stack.length > 0) stack[stack.length - 1] = true
      i++
      continue
    }
    const q = quantifierLength(source, i)
    if (q > 0) {
      if (stack.length > 0) stack[stack.length - 1] = true
      i += q
      continue
    }
    i++
  }
  return false
}

function skipCharClass(source: string, i: number): number {
  i++
  if (source[i] === '^') i++
  if (source[i] === ']') i++
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i += 2
    else i++
  }
  return i < source.length ? i + 1 : i
}

function skipGroupHead(source: string, i: number): number {
  if (source[i] !== '?') return i
  const next = source[i + 1]
  if (next === ':') return i + 2
  if (next === '=' || next === '!') return i + 2
  if (next === '<') {
    const after = source[i + 2]
    if (after === '=' || after === '!') return i + 3
    let j = i + 2
    while (j < source.length && source[j] !== '>') j++
    return j < source.length ? j + 1 : j
  }
  return i + 1
}

function quantifierLength(source: string, i: number): number {
  const ch = source[i]
  if (ch === '?' || ch === '+' || ch === '*') return source[i + 1] === '?' ? 2 : 1
  if (ch !== '{') return 0
  let j = i + 1
  if (!/\d/.test(source[j] ?? '')) return 0
  while (/\d/.test(source[j] ?? '')) j++
  if (source[j] === ',') {
    j++
    while (/\d/.test(source[j] ?? '')) j++
  }
  if (source[j] !== '}') return 0
  j++
  if (source[j] === '?') j++
  return j - i
}

/**
 * Two variable-width quantifiers with nothing consuming between them, on
 * the same or overlapping sets. Unquantified groups are transparent.
 * A quantified group exposes its set only when the body is one fixed atom.
 */
function adjacentVariableOverlap(source: string): boolean {
  return scanAtoms(source, 0, source.length, { prev: null, variable: false })
}

interface AtomChain {
  prev: SetPos | null
  variable: boolean
}

function scanAtoms(source: string, start: number, end: number, chain: AtomChain): boolean {
  let i = start
  while (i < end) {
    const ch = source[i]
    if (ch === '(') {
      const body = skipGroupHead(source, i + 1)
      const close = findGroupEnd(source, i)
      if (close < 0 || close >= end) return false
      const q = readQuantifier(source, close + 1)
      if (q.next > end) return false
      if (q.next === close + 1) {
        if (scanAtoms(source, body, close, chain)) return true
        i = close + 1
        continue
      }
      if (scanAtoms(source, body, close, { prev: null, variable: false })) return true
      const summarized = singleSet(source, body, close)
      if (
        summarized &&
        q.variable &&
        chain.variable &&
        chain.prev &&
        setsOverlap(chain.prev, summarized)
      ) {
        return true
      }
      chain.prev = summarized
      chain.variable = summarized ? q.variable : false
      i = q.next
      continue
    }
    if (ch === '|') {
      chain.prev = null
      chain.variable = false
      i++
      continue
    }
    if (ch === '^' || ch === '$') {
      i++
      continue
    }
    const atom = readAtom(source, i, end)
    if (!atom) return false
    if (atom.kind === 'assert') {
      i = atom.next
      continue
    }
    if (atom.variable && chain.variable && chain.prev && setsOverlap(chain.prev, atom.set)) return true
    chain.prev = atom.set
    chain.variable = atom.variable
    i = atom.next
  }
  return false
}

function singleSet(source: string, start: number, end: number): SetPos | null {
  let i = start
  while (i < end && (source[i] === '^' || source[i] === '$')) i++
  if (i >= end) return null
  const atom = readAtom(source, i, end)
  if (!atom || atom.kind !== 'atom' || atom.variable) return null
  i = atom.next
  while (i < end && (source[i] === '^' || source[i] === '$')) i++
  return i === end ? atom.set : null
}

type ReadAtom =
  | { kind: 'assert'; next: number }
  | { kind: 'atom'; set: SetPos; variable: boolean; next: number }

function readAtom(source: string, i: number, end: number): ReadAtom | null {
  if (i >= end) return null
  const ch = source[i]
  if ((ch === '{' || ch === '?' || ch === '+' || ch === '*') && quantifierLength(source, i) > 0) return null
  let set: SetPos
  let next: number
  if (ch === '\\') {
    const esc = readOutsideEscape(source, i, end)
    if (!esc) return null
    if (esc.assert) return { kind: 'assert', next: esc.next }
    set = esc.set
    next = esc.next
  } else if (ch === '[') {
    const cls = readClassAtom(source, i, end)
    if (!cls) return null
    set = cls.set
    next = cls.next
  } else if (ch === '.') {
    set = DOT
    next = i + 1
  } else {
    const cp = source.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    if (i + width > end) return null
    set = singleton(cp)
    next = i + width
  }
  const q = readQuantifier(source, next)
  if (q.next > end) return null
  return { kind: 'atom', set, variable: q.variable, next: q.next }
}

function readQuantifier(source: string, i: number): { variable: boolean; next: number } {
  const n = quantifierLength(source, i)
  if (n === 0) return { variable: false, next: i }
  const ch = source[i]
  if (ch === '?' || ch === '+' || ch === '*') return { variable: true, next: i + n }
  let j = i + 1
  let lo = 0
  while ((source[j] ?? '') >= '0' && (source[j] ?? '') <= '9') {
    lo = lo * 10 + source.charCodeAt(j) - 48
    j++
  }
  let hi = lo
  let ranged = false
  if (source[j] === ',') {
    j++
    ranged = true
    if ((source[j] ?? '') >= '0' && (source[j] ?? '') <= '9') {
      hi = 0
      while ((source[j] ?? '') >= '0' && (source[j] ?? '') <= '9') {
        hi = hi * 10 + source.charCodeAt(j) - 48
        j++
      }
    }
  }
  return { variable: ranged && hi > lo, next: i + n }
}

function findGroupEnd(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      i = skipCharClass(source, i)
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

interface SetPos {
  any: boolean
  neg: boolean
  ranges: Array<[number, number]>
}

const CP_MAX = 0x10ffff
const ANY: SetPos = { any: true, neg: false, ranges: [] }
const DIGIT_RANGES: Array<[number, number]> = [[48, 57]]
const WORD_RANGES: Array<[number, number]> = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]
const SPACE_RANGES: Array<[number, number]> = [
  [9, 13],
  [32, 32],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]
const LINE_RANGES: Array<[number, number]> = [
  [10, 10],
  [13, 13],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
]

const DIGITS: SetPos = { any: false, neg: false, ranges: DIGIT_RANGES }
const NOT_DIGITS: SetPos = { any: false, neg: true, ranges: DIGIT_RANGES }
const WORD: SetPos = { any: false, neg: false, ranges: WORD_RANGES }
const NOT_WORD: SetPos = { any: false, neg: true, ranges: WORD_RANGES }
const SPACE: SetPos = { any: false, neg: false, ranges: SPACE_RANGES }
const NOT_SPACE: SetPos = { any: false, neg: true, ranges: SPACE_RANGES }
const DOT: SetPos = { any: false, neg: true, ranges: LINE_RANGES }

function singleton(cp: number): SetPos {
  return { any: false, neg: false, ranges: [[cp, cp]] }
}

function setsOverlap(a: SetPos, b: SetPos): boolean {
  if (a.any || b.any) return true
  if (a.neg && b.neg) return !coversAll(normalize(a.ranges.concat(b.ranges)))
  if (a.neg) return !rangeContains(a.ranges, b.ranges)
  if (b.neg) return !rangeContains(b.ranges, a.ranges)
  return rangesOverlap(a.ranges, b.ranges)
}

function normalize(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return []
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  let lo = sorted[0][0]
  let hi = sorted[0][1]
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i][0]
    const b = sorted[i][1]
    if (a <= hi + 1) hi = Math.max(hi, b)
    else {
      out.push([lo, hi])
      lo = a
      hi = b
    }
  }
  out.push([lo, hi])
  return out
}

function rangesOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i][1] >= b[j][0] && b[j][1] >= a[i][0]) return true
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return false
}

function rangeContains(cover: Array<[number, number]>, inner: Array<[number, number]>): boolean {
  let j = 0
  for (let i = 0; i < inner.length; i++) {
    let pos = inner[i][0]
    const hi = inner[i][1]
    while (pos <= hi) {
      while (j < cover.length && cover[j][1] < pos) j++
      if (j >= cover.length || cover[j][0] > pos) return false
      pos = cover[j][1] + 1
    }
  }
  return true
}

function coversAll(ranges: Array<[number, number]>): boolean {
  return ranges.length === 1 && ranges[0][0] <= 0 && ranges[0][1] >= CP_MAX
}

function readOutsideEscape(
  source: string,
  i: number,
  end: number,
): { assert?: boolean; set: SetPos; next: number } | null {
  if (i + 1 >= end) return null
  const n = source[i + 1]
  if (n === 'b' || n === 'B') return { assert: true, set: ANY, next: i + 2 }
  if (n === 'd') return { set: DIGITS, next: i + 2 }
  if (n === 'D') return { set: NOT_DIGITS, next: i + 2 }
  if (n === 'w') return { set: WORD, next: i + 2 }
  if (n === 'W') return { set: NOT_WORD, next: i + 2 }
  if (n === 's') return { set: SPACE, next: i + 2 }
  if (n === 'S') return { set: NOT_SPACE, next: i + 2 }
  if (n === 'p' || n === 'P') {
    let j = i + 2
    if (source[j] === '{') {
      while (j < end && source[j] !== '}') j++
      if (j >= end || source[j] !== '}') return null
      j++
    }
    return { set: ANY, next: j }
  }
  if (n === 'k') {
    let j = i + 2
    if (source[j] === '<') {
      while (j < end && source[j] !== '>') j++
      if (j >= end) return null
      j++
    }
    return { set: ANY, next: j }
  }
  const cp = readOneEscapeCp(source, i, end)
  if (!cp) return null
  return { set: singleton(cp.cp), next: cp.next }
}

function readClassAtom(
  source: string,
  i: number,
  end: number,
): { set: SetPos; next: number } | null {
  if (source[i] !== '[') return null
  const closeAt = skipCharClass(source, i)
  if (closeAt > end || source[closeAt - 1] !== ']') return null
  let k = i + 1
  const stop = closeAt - 1
  let negated = false
  if (source[k] === '^') {
    negated = true
    k++
  }
  const parts: Array<[number, number]> = []
  let complementOnly: Array<[number, number]> | null = null
  let dirty = false
  let atStart = true
  const addPositive = (lo: number, hi: number) => {
    if (complementOnly) dirty = true
    parts.push([Math.min(lo, hi), Math.max(lo, hi)])
  }
  while (k < stop) {
    if (atStart && source[k] === ']') {
      addPositive(93, 93)
      k++
      atStart = false
      continue
    }
    atStart = false
    if (source[k] === '\\') {
      const esc = readClassEscape(source, k, stop)
      if (!esc) return null
      k = esc.next
      if (esc.complement) {
        if (negated || parts.length > 0 || complementOnly) dirty = true
        else complementOnly = esc.ranges ?? []
        continue
      }
      if (esc.ranges) {
        if (complementOnly) dirty = true
        for (let r = 0; r < esc.ranges.length; r++) parts.push(esc.ranges[r])
        continue
      }
      if (esc.cp === undefined) return null
      const lo = esc.cp
      if (k < stop && source[k] === '-' && k + 1 < stop) {
        k++
        const hiEsc = source[k] === '\\' ? readClassEscape(source, k, stop) : null
        if (source[k] === '\\') {
          if (!hiEsc || hiEsc.cp === undefined || hiEsc.ranges || hiEsc.complement) {
            dirty = true
            if (hiEsc) k = hiEsc.next
            continue
          }
          addPositive(lo, hiEsc.cp)
          k = hiEsc.next
          continue
        }
        const hi = source.codePointAt(k) ?? 0
        k += hi > 0xffff ? 2 : 1
        addPositive(lo, hi)
        continue
      }
      addPositive(lo, lo)
      continue
    }
    const lo = source.codePointAt(k) ?? 0
    k += lo > 0xffff ? 2 : 1
    if (k < stop && source[k] === '-' && k + 1 < stop) {
      k++
      if (source[k] === '\\') {
        const hiEsc = readClassEscape(source, k, stop)
        if (!hiEsc || hiEsc.cp === undefined || hiEsc.ranges || hiEsc.complement) {
          dirty = true
          if (hiEsc) k = hiEsc.next
          continue
        }
        addPositive(lo, hiEsc.cp)
        k = hiEsc.next
        continue
      }
      const hi = source.codePointAt(k) ?? 0
      k += hi > 0xffff ? 2 : 1
      addPositive(lo, hi)
      continue
    }
    addPositive(lo, lo)
  }
  if (dirty) return { set: ANY, next: closeAt }
  if (complementOnly && parts.length === 0 && !negated) {
    return { set: { any: false, neg: true, ranges: normalize(complementOnly) }, next: closeAt }
  }
  return { set: { any: false, neg: negated, ranges: normalize(parts) }, next: closeAt }
}

function readClassEscape(
  source: string,
  i: number,
  stop: number,
): { next: number; cp?: number; ranges?: Array<[number, number]>; complement?: boolean } | null {
  if (source[i] !== '\\' || i + 1 >= stop) return null
  const n = source[i + 1]
  if (n === 'd') return { next: i + 2, ranges: DIGIT_RANGES }
  if (n === 'D') return { next: i + 2, complement: true, ranges: DIGIT_RANGES }
  if (n === 'w') return { next: i + 2, ranges: WORD_RANGES }
  if (n === 'W') return { next: i + 2, complement: true, ranges: WORD_RANGES }
  if (n === 's') return { next: i + 2, ranges: SPACE_RANGES }
  if (n === 'S') return { next: i + 2, complement: true, ranges: SPACE_RANGES }
  if (n === 'b') return { next: i + 2, cp: 8 }
  const cp = readOneEscapeCp(source, i, stop)
  if (!cp) return null
  return { next: cp.next, cp: cp.cp }
}

function readOneEscapeCp(
  source: string,
  i: number,
  limit: number,
): { cp: number; next: number } | null {
  if (i + 1 >= limit) return null
  const n = source[i + 1]
  if (n === 'n') return { cp: 10, next: i + 2 }
  if (n === 'r') return { cp: 13, next: i + 2 }
  if (n === 't') return { cp: 9, next: i + 2 }
  if (n === 'f') return { cp: 12, next: i + 2 }
  if (n === 'v') return { cp: 11, next: i + 2 }
  if (n === '0') return { cp: 0, next: i + 2 }
  if (n === 'u') {
    if (source[i + 2] === '{') {
      let j = i + 3
      let v = 0
      let digits = 0
      while (j < limit && hexVal(source[j] ?? '') >= 0 && digits < 6) {
        v = (v << 4) + hexVal(source[j] ?? '')
        j++
        digits++
      }
      if (digits === 0 || source[j] !== '}' || v > CP_MAX) return null
      return { cp: v, next: j + 1 }
    }
    const v = readHex(source, i + 2, 4, limit)
    if (v === null) return null
    return { cp: v, next: i + 6 }
  }
  if (n === 'x') {
    const v = readHex(source, i + 2, 2, limit)
    if (v === null) return null
    return { cp: v, next: i + 4 }
  }
  const cp = source.codePointAt(i + 1) ?? 0
  return { cp, next: i + 1 + (cp > 0xffff ? 2 : 1) }
}

function readHex(source: string, i: number, n: number, limit: number): number | null {
  if (i + n > limit) return null
  let v = 0
  for (let k = 0; k < n; k++) {
    const h = hexVal(source[i + k] ?? '')
    if (h < 0) return null
    v = (v << 4) + h
  }
  return v
}

function hexVal(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48
  if (ch >= 'a' && ch <= 'f') return ch.charCodeAt(0) - 87
  if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55
  return -1
}

function matchGlob(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase()
  const v = value.trim().toLowerCase()
  if (p === '*' || p === '*.*') return true
  if (p.endsWith('.*')) return v.startsWith(p.slice(0, -1))
  if (p.startsWith('*.')) return v.endsWith(p.slice(1))
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1))
  return p === v
}

export function columnMatches(globs: string[], column: string): boolean {
  const keyLower = column.toLowerCase()
  const bare = keyLower.includes('.') ? keyLower.slice(keyLower.lastIndexOf('.') + 1) : keyLower
  return globs.some((g) => {
    const p = g.trim().toLowerCase()
    if (matchGlob(p, keyLower) || matchGlob(p, bare)) return true
    return p.slice(p.lastIndexOf('.') + 1) === keyLower || p.slice(p.lastIndexOf('.') + 1) === bare
  })
}

function ownCount(bag: Record<string, number>, key: string): number {
  if (!Object.prototype.hasOwnProperty.call(bag, key)) return 0
  const n = bag[key]
  return typeof n === 'number' ? n : 0
}

function addOwnCount(bag: Record<string, number>, key: string, n: number): void {
  Object.defineProperty(bag, key, {
    value: ownCount(bag, key) + n,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

export function mergeByClass(
  into: Record<string, number>,
  add?: Record<string, number>,
): Record<string, number> {
  if (!add) return into
  for (const key of Object.keys(add)) {
    const n = ownCount(add, key)
    if (n > 0) addOwnCount(into, key, n)
  }
  return into
}

export function applyCustomPatterns(
  text: string,
  compiled: CompiledCustomPattern[],
  column?: string,
): { text: string; count: number; byClass: Record<string, number> } {
  if (!compiled.length) return { text, count: 0, byClass: {} }

  let out = text
  let count = 0
  const byClass: Record<string, number> = {}

  for (const rule of compiled) {
    if (rule.columns.length > 0) {
      if (!column || !columnMatches(rule.columns, column)) continue
    }

    const re = new RegExp(rule.re.source, rule.re.flags)
    let hits = 0
    const next = out.replace(re, () => {
      hits++
      return rule.label
    })

    if (hits === 0) continue
    if (hits > CUSTOM_PATTERN_MAX_MATCHES) {
      addOwnCount(byClass, rule.name, 1)
      return { text: rule.label, count: count + 1, byClass }
    }
    out = next
    count += hits
    addOwnCount(byClass, rule.name, hits)
  }

  return { text: out, count, byClass }
}
