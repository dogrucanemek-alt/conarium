/**
 * User-defined PII patterns from config.
 *
 * Same response-path scanner as the built-in detectors — not a second masker.
 * The pattern text is treated as sensitive: errors, logs and receipts carry
 * the rule NAME only.
 *
 * User regex is ReDoS-risky. Compile keeps the 0.2.54 reject list (lookaround,
 * backreferences, `+` / `*`, open `{n,}`, source and quantifier caps, the two
 * old group rules). Accepted patterns run on re2js, which matches in linear time.
 * A broken rule fails the config (silent drop = leak).
 */
import { RE2JS } from 're2js'
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
  | 'unsupported-flag'
  | 'unsupported-case-word'
  | 'unsupported-empty-choice'
  | 'unsupported-surrogate'

const REJECT_MESSAGE: Record<CustomPatternReject, (name: string) => string> = {
  invalid: (name) => `customPatterns: rule "${name}" is not a valid regular expression`,
  unsafe: (name) => `customPatterns: rule "${name}" was rejected (unbounded or nested quantifiers)`,
  duplicate: (name) => `customPatterns: rule name "${name}" is duplicated`,
  empty: (name) => `customPatterns: rule "${name}" has an empty pattern`,
  'too-long': (name) => `customPatterns: rule "${name}" exceeds the pattern length cap`,
  'bad-name': (name) => `customPatterns: rule name "${name}" is not allowed`,
  'bad-label': (name) => `customPatterns: rule "${name}" has an invalid mask label`,
  'unsupported-flag': (name) =>
    `customPatterns: rule "${name}" was rejected (multiline flag m)`,
  'unsupported-case-word': (name) =>
    `customPatterns: rule "${name}" was rejected (case-insensitive word characters)`,
  'unsupported-empty-choice': (name) =>
    `customPatterns: rule "${name}" was rejected (empty choice inside a repeated group)`,
  'unsupported-surrogate': (name) =>
    `customPatterns: rule "${name}" was rejected (lone surrogate escape)`,
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

export interface CustomPatternMatch {
  start: number
  end: number
}

export interface CompiledCustomPattern {
  name: string
  columns: string[]
  label: string
  /** Source kept only in memory for lastIndex-safe clones. Never logged. */
  re: RegExp
  /** Leftmost-first matches, `String.prototype.replace` + `gu` semantics. */
  matches(text: string): CustomPatternMatch[]
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const LABEL_RE = /^\[[A-Za-z][A-Za-z0-9._-]{0,61}\]$/

/** JS `u` whitespace, written so re2js sees the same code points. */
const JS_SPACE =
  '\\t\\n\\x{0b}\\f\\r \\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}'
/**
 * Complement of {@link JS_SPACE}, for `\S` inside a class.
 * re2js `\S` is only the complement of Perl space, so U+00A0 and the other
 * JS spaces would be masked or leaked if the escape were left as `\S`.
 */
const JS_NON_SPACE =
  '\\x{0}-\\x{8}\\x{e}-\\x{1f}\\x{21}-\\x{9f}\\x{a1}-\\x{167f}\\x{1681}-\\x{1fff}\\x{200b}-\\x{2027}\\x{202a}-\\x{202e}\\x{2030}-\\x{205e}\\x{2060}-\\x{2fff}\\x{3001}-\\x{fefe}\\x{ff00}-\\x{10ffff}'
/** JS `u` dot: any code point except LF, CR, LS, PS. */
const JS_DOT = '[^\\n\\r\\x{2028}\\x{2029}]'
/** `[]` matches nothing. `[^]` matches every code point, line breaks included. */
const JS_NEVER = '[^\\x{0}-\\x{10ffff}]'
const JS_ANY = '[\\x{0}-\\x{10ffff}]'

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

  let engine: RE2JS
  try {
    engine = RE2JS.compile(toEngineSource(source, item.name))
  } catch (err) {
    if (err instanceof CustomPatternError) throw err
    throw new CustomPatternError(item.name, 'invalid')
  }

  return {
    name: item.name,
    columns: (item.columns ?? []).filter(Boolean),
    label,
    re,
    matches(text: string): CustomPatternMatch[] {
      return scanEngine(engine, text)
    },
  }
}

/**
 * Conservative static reject. Linear class quantifiers (`[0-9]{8}`) pass.
 * Anything that can explode backtracking — or is simply unbounded — does not.
 *
 * This is the 0.2.54 rule. Nested quantifiers, alternation inside a quantified
 * group, and adjacent variable quantifiers are not rejected here: those shapes
 * run on the linear engine.
 */
export function looksUnsafe(source: string): boolean {
  if (/\(\?[=!<]/.test(source)) return true
  if (/\\[1-9]/.test(source)) return true
  if (/[+*]/.test(source)) return true
  if (/\{\d+,\}/.test(source)) return true
  if (/\([^)]*[+*{][^)]*\)[+*{?]/.test(source)) return true
  if (/\([^)]*\|[^)]*\)[+*{]/.test(source)) return true
  if (/\([^)]*\)[+*]/.test(source)) return true

  for (const m of source.matchAll(/\{(\d+)(?:,(\d+))?\}/g)) {
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return true
    if (hi < lo) return true
    if (hi > CUSTOM_PATTERN_MAX_QUANTIFIER) return true
    if (hi - lo > CUSTOM_PATTERN_MAX_QUANTIFIER) return true
  }
  return false
}

/**
 * re2js source for a pattern JS already accepted with the `u` flag.
 * `\u` escapes become `\x{…}`. `.` is rewritten to the JS set wherever that
 * group's own `s` flag is off (`-s` turns it off, including in nested groups;
 * inside `(?s:…)` the dot stays and matches every character). An inline group
 * that turns `m` on is refused: JS multiline also stops at CR, U+2028 and
 * U+2029, and re2js stops only at LF. `\s` / `\S` are rewritten where their
 * default re2js sets differ from JS `u`. `\p` / `\P` become the code-point
 * ranges JavaScript accepts for that body, cached per body. re2js never sees
 * `\p` and never uses its own Unicode tables.
 * A `\uHHHH\uLLLL` lead+trail pair (both four hex digits, nothing between
 * them) is one code point. Any other `\u` escape whose value is
 * U+D800–U+DFFF — `\u{…}`, a mixed pair, a split pair, a class member, or a
 * range end — is refused.
 * `[]`, `[^]` and in-class `\b` are rewritten to sets re2js parses the way
 * JavaScript does. An `i`-enabling group anywhere next to a word escape, and
 * a variable quantifier whose body prefers an empty choice, are refused.
 */
function toEngineSource(source: string, ruleName = ''): string {
  rejectCaseInsensitiveWord(source, ruleName)
  rejectEmptyPreferringRepeat(source, ruleName)
  return rewriteUnicode(RE2JS.translateRegExp(foldSurrogatePairs(source, ruleName)), ruleName)
}

/** `(?ims-ims:…)` at `open`, or null when this `(` is some other group. */
function modifierGroup(
  source: string,
  open: number,
): { end: number; enableS: boolean; disableS: boolean; enableM: boolean; enableI: boolean } | null {
  if (source[open + 1] !== '?') return null
  let j = open + 2
  let phase: 'on' | 'off' = 'on'
  let saw = false
  let enableS = false
  let disableS = false
  let enableM = false
  let enableI = false
  while (j < source.length) {
    const c = source[j]
    if (c === ':') {
      if (!saw) return null
      return { end: j + 1, enableS, disableS, enableM, enableI }
    }
    if (c === '-') {
      if (phase === 'off') return null
      phase = 'off'
      saw = true
      j++
      continue
    }
    if (c !== 'i' && c !== 'm' && c !== 's') return null
    saw = true
    if (c === 's') {
      if (phase === 'on') enableS = true
      else disableS = true
    } else if (c === 'm' && phase === 'on') {
      enableM = true
    } else if (c === 'i' && phase === 'on') {
      enableI = true
    }
    j++
  }
  return null
}

/**
 * Length of one escape starting at `i` (`\`). Brace forms consume through `}`.
 * An unknown tail is two characters, which is enough to keep `\\` from
 * swallowing the next escape.
 */
function escapeLength(source: string, i: number): number {
  if (source[i] !== '\\') return 1
  const n = source[i + 1]
  if (n === undefined) return 1
  if ((n === 'u' || n === 'x' || n === 'p' || n === 'P') && source[i + 2] === '{') {
    const end = source.indexOf('}', i + 3)
    return end === -1 ? 2 : end - i + 1
  }
  if (n === 'u' && /^[0-9A-Fa-f]{4}/.test(source.slice(i + 2, i + 6))) return 6
  if (n === 'x' && /^[0-9A-Fa-f]{2}/.test(source.slice(i + 2, i + 4))) return 4
  if (n === 'c' && source[i + 2] !== undefined) return 3
  return 2
}

/** `\uHHHH` of exactly four hex digits, not the `\u{…}` form. */
function readBmpEscape(source: string, i: number): { value: number; end: number } | null {
  if (escapeLength(source, i) !== 6) return null
  if (source[i + 1] !== 'u' || source[i + 2] === '{') return null
  return { value: Number.parseInt(source.slice(i + 2, i + 6), 16), end: i + 6 }
}

/** `\u{hex}` form. A surrogate value here is never half of a `\uHHHH\uLLLL` pair. */
function readBraceEscape(source: string, i: number): { value: number; end: number } | null {
  if (source[i] !== '\\' || source[i + 1] !== 'u' || source[i + 2] !== '{') return null
  const end = source.indexOf('}', i + 3)
  if (end === -1) return null
  const hex = source.slice(i + 3, end)
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null
  const value = Number.parseInt(hex, 16)
  if (!Number.isFinite(value)) return null
  return { value, end: end + 1 }
}

function isSurrogateValue(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff
}

/**
 * In the `u` flag, `\u` lead + `\u` trail glued together is one code point.
 * A surrogate escape that is not half of that four-digit pair is refused:
 * JavaScript never matches it against half of a real pair, and re2js would.
 */
function foldSurrogatePairs(source: string, ruleName: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source[i] === '\\' && source[i + 1] === '\\') {
      out += '\\\\'
      i += 2
      continue
    }
    const hi = readBmpEscape(source, i)
    if (hi && hi.value >= 0xd800 && hi.value <= 0xdbff) {
      const lo = readBmpEscape(source, hi.end)
      if (lo && lo.value >= 0xdc00 && lo.value <= 0xdfff) {
        const cp = (hi.value - 0xd800) * 0x400 + (lo.value - 0xdc00) + 0x10000
        out += `\\x{${cp.toString(16)}}`
        i = lo.end
        continue
      }
      throw new CustomPatternError(ruleName, 'unsupported-surrogate')
    }
    if (hi && hi.value >= 0xdc00 && hi.value <= 0xdfff) {
      throw new CustomPatternError(ruleName, 'unsupported-surrogate')
    }
    const brace = readBraceEscape(source, i)
    if (brace && isSurrogateValue(brace.value)) {
      throw new CustomPatternError(ruleName, 'unsupported-surrogate')
    }
    out += source[i]
    i++
  }
  return out
}

/**
 * V8, once any group turns `i` on, treats `\w` / `\W` / `\b` / `\B` as
 * Unicode word characters everywhere in the pattern. re2js keeps them ASCII.
 */
function rejectCaseInsensitiveWord(source: string, ruleName: string): void {
  let enableI = false
  let word = false
  let i = 0
  while (i < source.length) {
    if (source[i] === '\\') {
      const n = source[i + 1]
      if (n === 'w' || n === 'W' || n === 'b' || n === 'B') word = true
      i += escapeLength(source, i)
      continue
    }
    if (source[i] === '(') {
      const mods = modifierGroup(source, i)
      if (mods?.enableI) enableI = true
    }
    i++
  }
  if (enableI && word) throw new CustomPatternError(ruleName, 'unsupported-case-word')
}

/**
 * Whether a node is "empty-last": an empty match is not chosen while a
 * non-empty one is still available later. re2js takes that empty choice;
 * JavaScript backtracks into the repeated group. A quantifier whose upper
 * bound is above its lower bound is refused when its body is not empty-last.
 */
type EmptyLast = { el: boolean; canEmpty: boolean; canNonEmpty: boolean }

function charNode(): EmptyLast {
  return { el: true, canEmpty: false, canNonEmpty: true }
}
function emptyNode(): EmptyLast {
  return { el: true, canEmpty: true, canNonEmpty: false }
}
function nothingNode(): EmptyLast {
  return { el: true, canEmpty: false, canNonEmpty: false }
}

function rejectEmptyPreferringRepeat(source: string, ruleName: string): void {
  let i = 0

  const fail = (): never => {
    throw new CustomPatternError(ruleName, 'invalid')
  }

  const escapeNode = (at: number): EmptyLast => {
    const n = source[at + 1]
    if (n === 'b' || n === 'B') return emptyNode()
    return charNode()
  }

  const parseClass = (): EmptyLast => {
    if (source[i + 1] === ']') {
      i += 2
      return nothingNode()
    }
    if (source[i + 1] === '^' && source[i + 2] === ']') {
      i += 3
      return charNode()
    }
    i++
    if (source[i] === '^') i++
    while (i < source.length) {
      if (source[i] === '\\') {
        i += escapeLength(source, i)
        continue
      }
      if (source[i] === ']') {
        i++
        return charNode()
      }
      const cp = source.codePointAt(i) ?? 0
      i += cp > 0xffff ? 2 : 1
    }
    return fail()
  }

  const parseGroup = (): EmptyLast => {
    if (source.startsWith('(?:', i)) {
      i += 3
    } else if (source[i + 1] === '?') {
      const mods = modifierGroup(source, i)
      if (!mods) return fail()
      i = mods.end
    } else {
      i++
    }
    const body = parseAlt()
    if (source[i] !== ')') return fail()
    i++
    return body
  }

  const parseAtom = (): EmptyLast => {
    const c = source[i]
    if (c === undefined || c === ')' || c === '|') return fail()
    if (c === '(') return parseGroup()
    if (c === '[') return parseClass()
    if (c === '\\') {
      const node = escapeNode(i)
      i += escapeLength(source, i)
      return node
    }
    if (c === '^' || c === '$') {
      i++
      return emptyNode()
    }
    const cp = source.codePointAt(i) ?? 0
    i += cp > 0xffff ? 2 : 1
    return charNode()
  }

  const parseQuantifier = (): { min: number; max: number; lazy: boolean } | null => {
    if (source[i] === '?') {
      i++
      const lazy = source[i] === '?'
      if (lazy) i++
      return { min: 0, max: 1, lazy }
    }
    if (source[i] !== '{') return null
    const m = /^\{(\d+)(?:,(\d+))?\}/.exec(source.slice(i))
    if (!m) return null
    i += m[0].length
    const lazy = source[i] === '?'
    if (lazy) i++
    const min = Number(m[1])
    const max = m[2] === undefined ? min : Number(m[2])
    return { min, max, lazy }
  }

  const quantify = (atom: EmptyLast, q: { min: number; max: number; lazy: boolean }): EmptyLast => {
    if (q.max > q.min && !atom.el) throw new CustomPatternError(ruleName, 'unsupported-empty-choice')
    const nothing = !atom.canEmpty && !atom.canNonEmpty
    const canEmpty = nothing ? q.min === 0 : q.min === 0 || atom.canEmpty
    const canNonEmpty = !nothing && atom.canNonEmpty && q.max >= 1
    const variable = q.max > q.min
    let el: boolean
    if (q.lazy && variable && atom.canNonEmpty) el = false
    else if (variable) el = atom.el
    else if (!canEmpty) el = true
    else el = atom.el
    return { el, canEmpty, canNonEmpty }
  }

  const parseQuantified = (): EmptyLast => {
    const atom = parseAtom()
    const q = parseQuantifier()
    return q ? quantify(atom, q) : atom
  }

  const concatNode = (items: EmptyLast[]): EmptyLast => {
    if (items.length === 0) return emptyNode()
    const parts = items.map((item) => ({ ...item }))
    for (let p = 0; p < parts.length; p++) {
      const onlyEmpty = parts[p].canEmpty && !parts[p].canNonEmpty
      if (!onlyEmpty) continue
      let later = false
      for (let q = p + 1; q < parts.length; q++) {
        if (parts[q].canNonEmpty) {
          later = true
          break
        }
      }
      if (later) parts[p].el = false
    }
    const blocked = parts.some((p) => !p.canEmpty && !p.canNonEmpty)
    return {
      el: parts.every((p) => p.el),
      canEmpty: !blocked && parts.every((p) => p.canEmpty),
      canNonEmpty: !blocked && parts.some((p) => p.canNonEmpty),
    }
  }

  const altNode = (branches: EmptyLast[]): EmptyLast => {
    let emptyThenFull = false
    for (let b = 0; b < branches.length && !emptyThenFull; b++) {
      if (!branches[b].canEmpty) continue
      for (let a = b + 1; a < branches.length; a++) {
        if (branches[a].canNonEmpty) {
          emptyThenFull = true
          break
        }
      }
    }
    return {
      el: branches.every((b) => b.el) && !emptyThenFull,
      canEmpty: branches.some((b) => b.canEmpty),
      canNonEmpty: branches.some((b) => b.canNonEmpty),
    }
  }

  const parseConcat = (): EmptyLast => {
    const items: EmptyLast[] = []
    while (i < source.length && source[i] !== '|' && source[i] !== ')') items.push(parseQuantified())
    return concatNode(items)
  }

  const parseAlt = (): EmptyLast => {
    const branches = [parseConcat()]
    while (source[i] === '|') {
      i++
      branches.push(parseConcat())
    }
    return altNode(branches)
  }

  parseAlt()
  if (i !== source.length) fail()
}

const PROPERTY_BODY_RE = /^[A-Za-z0-9_=]+$/
const UNICODE_LAST = 0x10ffff

/** Inclusive code-point spans, sorted, disjoint. One entry per BODY, for the process. */
type CodeSpan = readonly [number, number]
const propertyRangeCache = new Map<string, readonly CodeSpan[]>()

/**
 * Code points JS's `u` flag accepts for `\p{body}`, including the surrogate
 * range when JS itself matches them. The second compile of the same body
 * reads the map and does not scan again.
 */
function jsPropertyRanges(body: string, ruleName: string): readonly CodeSpan[] {
  if (!PROPERTY_BODY_RE.test(body)) throw new CustomPatternError(ruleName, 'invalid')
  const cached = propertyRangeCache.get(body)
  if (cached) return cached
  let probe: RegExp
  try {
    probe = new RegExp('^\\p{' + body + '}$', 'u')
  } catch {
    throw new CustomPatternError(ruleName, 'invalid')
  }
  const ranges: CodeSpan[] = []
  let start = -1
  for (let cp = 0; cp <= UNICODE_LAST; cp++) {
    if (probe.test(String.fromCodePoint(cp))) {
      if (start < 0) start = cp
    } else if (start >= 0) {
      ranges.push([start, cp - 1])
      start = -1
    }
  }
  if (start >= 0) ranges.push([start, UNICODE_LAST])
  propertyRangeCache.set(body, ranges)
  return ranges
}

function complementSpans(ranges: readonly CodeSpan[]): CodeSpan[] {
  const out: CodeSpan[] = []
  let next = 0
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1])
    next = hi + 1
  }
  if (next <= UNICODE_LAST) out.push([next, UNICODE_LAST])
  return out
}

function formatSpans(ranges: readonly CodeSpan[]): string {
  let out = ''
  for (const [lo, hi] of ranges) {
    out += `\\x{${lo.toString(16)}}`
    if (hi !== lo) out += `-\\x{${hi.toString(16)}}`
  }
  return out
}

/**
 * `\P` is the negative context: those spans are the complement. A surrounding
 * `[^…]` is left as written, so it complements whatever this returns.
 * An empty set matches nothing outside a class and adds nothing inside one.
 */
function rewriteUnicodeProperty(
  body: string,
  negated: boolean,
  inClass: boolean,
  ruleName: string,
): string {
  const spans = negated
    ? complementSpans(jsPropertyRanges(body, ruleName))
    : jsPropertyRanges(body, ruleName)
  if (spans.length === 0) return inClass ? '' : '[^\\x{0}-\\x{10ffff}]'
  const text = formatSpans(spans)
  return inClass ? text : `[${text}]`
}

function rewriteUnicode(source: string, ruleName: string): string {
  let out = ''
  let i = 0
  let inClass = false
  let atClassStart = false
  // Top level is compiled with `gu`, so `s` starts off. Each `(` pushes the
  // dotall state of that group; `-s` clears it and `(?s:)` sets it.
  const dotAllStack: boolean[] = [false]
  const dotAllNow = (): boolean => dotAllStack[dotAllStack.length - 1] ?? false
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === 's' || next === 'S') {
        out += whitespaceEscape(next, inClass)
        i += 2
        atClassStart = false
        continue
      }
      if (next === 'p' || next === 'P') {
        const end = source[i + 2] === '{' ? source.indexOf('}', i + 3) : -1
        if (end === -1) throw new CustomPatternError(ruleName, 'invalid')
        out += rewriteUnicodeProperty(source.slice(i + 3, end), next === 'P', inClass, ruleName)
        i = end + 1
        atClassStart = false
        continue
      }
      // In a class `\b` is U+0008. re2js rejects that escape and keeps the word boundary.
      if (inClass && next === 'b') {
        out += '\\x{8}'
        i += 2
        atClassStart = false
        continue
      }
      out += '\\'
      if (next === undefined) {
        i += 1
        continue
      }
      out += next
      i += 2
      atClassStart = false
      continue
    }
    if (!inClass && ch === '(') {
      const mods = modifierGroup(source, i)
      if (mods) {
        if (mods.enableM) throw new CustomPatternError(ruleName, 'unsupported-flag')
        let dotAll = dotAllNow()
        if (mods.enableS) dotAll = true
        if (mods.disableS) dotAll = false
        dotAllStack.push(dotAll)
        out += source.slice(i, mods.end)
        i = mods.end
        continue
      }
      dotAllStack.push(dotAllNow())
      out += ch
      i++
      continue
    }
    if (!inClass && ch === ')') {
      if (dotAllStack.length > 1) dotAllStack.pop()
      out += ch
      i++
      continue
    }
    if (!inClass && ch === '[') {
      // `[]` matches nothing and `[^]` matches every code point. re2js treats
      // the `]` as a literal member of the class instead.
      if (source[i + 1] === ']') {
        out += JS_NEVER
        i += 2
        continue
      }
      if (source[i + 1] === '^' && source[i + 2] === ']') {
        out += JS_ANY
        i += 3
        continue
      }
      inClass = true
      atClassStart = true
      out += ch
      i++
      continue
    }
    if (inClass && atClassStart && ch === '^') {
      out += ch
      i++
      continue
    }
    if (inClass && ch === ']' && !atClassStart) {
      inClass = false
      out += ch
      i++
      continue
    }
    if (!inClass && ch === '.' && !dotAllNow()) {
      out += JS_DOT
      i++
      continue
    }
    out += ch
    i++
    atClassStart = false
  }
  return out
}

function whitespaceEscape(kind: 's' | 'S', inClass: boolean): string {
  if (inClass) {
    if (kind === 's') return JS_SPACE
    return JS_NON_SPACE
  }
  if (kind === 's') return `[${JS_SPACE}]`
  return `[^${JS_SPACE}]`
}

/** Global search: after a zero-width hit, re2js steps one code point. */
function scanEngine(engine: RE2JS, text: string): CustomPatternMatch[] {
  const matcher = engine.matcher(text)
  const out: CustomPatternMatch[] = []
  const limit = text.length + 1
  while (matcher.find()) {
    out.push({ start: matcher.start(), end: matcher.end() })
    if (out.length > limit) break
  }
  return out
}

/** Same scan as {@link CompiledCustomPattern.matches}, for a source string. */
export function matchCustomPatternSource(source: string, text: string): CustomPatternMatch[] {
  return scanEngine(RE2JS.compile(toEngineSource(source)), text)
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

function replaceWithLabel(text: string, matches: CustomPatternMatch[], label: string): string {
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    out += label
    cursor = match.end
  }
  out += text.slice(cursor)
  return out
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

    const hits = rule.matches(out)
    if (hits.length === 0) continue
    if (hits.length > CUSTOM_PATTERN_MAX_MATCHES) {
      addOwnCount(byClass, rule.name, 1)
      return { text: rule.label, count: count + 1, byClass }
    }
    out = replaceWithLabel(out, hits, rule.label)
    count += hits.length
    addOwnCount(byClass, rule.name, hits.length)
  }

  return { text: out, count, byClass }
}
