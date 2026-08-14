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

export function mergeByClass(
  into: Record<string, number>,
  add?: Record<string, number>,
): Record<string, number> {
  if (!add) return into
  for (const [k, n] of Object.entries(add)) {
    if (n > 0) into[k] = (into[k] ?? 0) + n
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
      byClass[rule.name] = (byClass[rule.name] ?? 0) + 1
      return { text: rule.label, count: count + 1, byClass }
    }
    out = next
    count += hits
    byClass[rule.name] = (byClass[rule.name] ?? 0) + hits
  }

  return { text: out, count, byClass }
}
