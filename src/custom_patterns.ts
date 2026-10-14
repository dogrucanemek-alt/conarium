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
/** JS `u` dot: any code point except LF, CR, LS, PS. */
const JS_DOT = '[^\\n\\r\\x{2028}\\x{2029}]'

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
    engine = RE2JS.compile(toEngineSource(source))
  } catch {
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
 * `\u` escapes become `\x{…}`. `.` and `\s` / `\S` are rewritten where their
 * default re2js sets differ from JS `u`.
 */
function toEngineSource(source: string): string {
  const translated = RE2JS.translateRegExp(source)
  return rewriteUnicode(translated, !/\(\?[-a-zA-Z]*s/.test(translated))
}

function rewriteUnicode(source: string, rewriteDot: boolean): string {
  let out = ''
  let i = 0
  let inClass = false
  let atClassStart = false
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
    if (!inClass && ch === '[') {
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
    if (!inClass && rewriteDot && ch === '.') {
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
    return '\\S'
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
