/**
 * User-defined PII patterns from config.
 *
 * Same response-path scanner as the built-in detectors — not a second masker.
 * The pattern text is treated as sensitive: errors, logs and receipts carry
 * the rule NAME only.
 *
 * User regex is ReDoS-risky. Compile keeps the 0.2.54 reject list (lookaround,
 * backreferences, `+` / `*`, open `{n,}`, source and quantifier caps, the two
 * old group rules). Accepted patterns are parsed once and emitted as re2js
 * source, which matches in linear time.
 * Nested repeats whose written maxima divide a budget of 1000 down to zero
 * are rejected, because re2js refuses that product while parsing. re2js checks
 * each repeat on its own from 1000; a zero-count repeat only cuts the count
 * coming from outside, and the nest inside is still checked.
 * A broken rule fails the config (silent drop = leak).
 */
import { RegExpParser } from '@eslint-community/regexpp'
import type { AST } from '@eslint-community/regexpp'
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

/** Inclusive code-point spans, sorted and disjoint once unioned. */
type CodeSpan = readonly [number, number]

/**
 * JS `u` whitespace, one span list. `\s` and `\S` (inside and outside a class)
 * are both written from this list.
 */
const JS_SPACE_SPANS: readonly CodeSpan[] = [
  [0x0009, 0x000d],
  [0x0020, 0x0020],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]
const DIGIT_SPANS: readonly CodeSpan[] = [[0x30, 0x39]]
/** ASCII `\w`: digits, `A–Z`, `_`, `a–z`. Case-insensitive `\w` is refused. */
const WORD_SPANS: readonly CodeSpan[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]
/** JS `u` dot: any code point except LF, CR, LS, PS. */
const JS_DOT = '[^\\n\\r\\x{2028}\\x{2029}]'
/** `[]` matches nothing. `[^]` matches every code point, line breaks included. */
const JS_NEVER = '[^\\x{0}-\\x{10ffff}]'
const JS_ANY = '[\\x{0}-\\x{10ffff}]'
/**
 * re2js checks each repeat on its own from this budget. Each written
 * quantifier integer-divides it by its maximum (`?` is 1). A zero-count
 * repeat (`{0}`, `{0,0}`) does not divide: it only cuts the count coming
 * from outside, and the body is checked again from 1000. A budget of zero
 * is a refusal.
 */
const NESTED_REPEAT_BUDGET = 1000

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
 * re2js source for a pattern JavaScript already accepted with the `u` flag.
 *
 * One parse and one walk. The walk carries an `i` / `s` stack (both start
 * off; the compile flags are `gu`) and, on every node, the empty-choice
 * attributes and the re2js text. `s` only chooses which set `.` becomes.
 * `s` and `m` are never written out. The walk starts with a budget of 1000;
 * a quantifier that is written passes its child the budget it received,
 * integer-divided by that quantifier's maximum (its minimum
 * when the repeat is open). A zero-count repeat (`{0}`, `{0,0}`) only cuts
 * the count coming from outside: its body starts again at 1000, and a nested
 * repeat found there is still carried upward. A zero budget is rejected
 * because re2js will not parse the nest.
 * Refusals are thrown in order:
 * case-insensitive word characters, an empty choice in a repeated group,
 * a lone surrogate, the multiline flag, nested repeats, then `invalid`.
 * A node that matches nothing is a single never-set and is never left under
 * a quantifier. Characters are `\x{…}`. `\s` / `\S` / `\p` / `\P` become
 * the ranges JavaScript uses; a property is cached by its raw brace text.
 * An assertion (`^` `$` `\b` `\B`) is not an empty choice.
 */
function toEngineSource(source: string, ruleName = ''): string {
  let pattern: AST.Pattern
  try {
    pattern = new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, {
      unicode: true,
    })
  } catch {
    // The engine accepted it and the parser did not. Fail closed; the message
    // stays the rule name.
    throw new CustomPatternError(ruleName, 'invalid')
  }
  const ctx: WalkContext = {
    ruleName,
    refusals: {
      caseIgnore: false,
      word: false,
      emptyChoice: false,
      surrogate: false,
      multiline: false,
      nestedRepeat: false,
      invalid: false,
    },
  }
  const walked = walkNode(pattern, { ignoreCase: false, dotAll: false }, ctx, NESTED_REPEAT_BUDGET)
  if (walked.repeatOver) ctx.refusals.nestedRepeat = true
  throwCollected(ruleName, ctx.refusals)
  // `[]|` drops the nothing branch and leaves only an empty alternative.
  return walked.text === '' ? '(?:)' : walked.text
}


/**
 * Empty-last: an empty match is not chosen while a non-empty one is still
 * available later. A variable quantifier is refused when its body can match
 * empty and is not empty-last. An assertion is not a choice, so `^`, `$`,
 * `\b` and `\B` do not clear empty-last on a concatenation. An empty
 * alternative before a non-empty one still does.
 */
type EmptyLast = { el: boolean; canEmpty: boolean; canNonEmpty: boolean }
type Walked = { attr: EmptyLast; text: string; repeatOver?: boolean }
type FlagState = { ignoreCase: boolean; dotAll: boolean }
type Refusals = {
  caseIgnore: boolean
  word: boolean
  emptyChoice: boolean
  surrogate: boolean
  multiline: boolean
  nestedRepeat: boolean
  invalid: boolean
}
type WalkContext = { ruleName: string; refusals: Refusals }

function charNode(): EmptyLast {
  return { el: true, canEmpty: false, canNonEmpty: true }
}
function emptyNode(): EmptyLast {
  return { el: true, canEmpty: true, canNonEmpty: false }
}
function nothingNode(): EmptyLast {
  return { el: true, canEmpty: false, canNonEmpty: false }
}

function isNothing(attr: EmptyLast): boolean {
  return !attr.canEmpty && !attr.canNonEmpty
}

function isSurrogateValue(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff
}

function throwCollected(ruleName: string, refusals: Refusals): void {
  if (refusals.caseIgnore && refusals.word) {
    throw new CustomPatternError(ruleName, 'unsupported-case-word')
  }
  if (refusals.emptyChoice) throw new CustomPatternError(ruleName, 'unsupported-empty-choice')
  if (refusals.surrogate) throw new CustomPatternError(ruleName, 'unsupported-surrogate')
  if (refusals.multiline) throw new CustomPatternError(ruleName, 'unsupported-flag')
  if (refusals.nestedRepeat) throw new CustomPatternError(ruleName, 'unsafe')
  if (refusals.invalid) throw new CustomPatternError(ruleName, 'invalid')
}

function quantify(atom: EmptyLast, min: number, max: number, lazy: boolean, ctx: WalkContext): EmptyLast {
  if (max > min && atom.canEmpty && !atom.el) ctx.refusals.emptyChoice = true
  const nothing = !atom.canEmpty && !atom.canNonEmpty
  const canEmpty = nothing ? min === 0 : min === 0 || atom.canEmpty
  const canNonEmpty = !nothing && atom.canNonEmpty && max >= 1
  const variable = max > min
  let el: boolean
  if (!canEmpty) el = true
  else if (lazy && variable && atom.canNonEmpty) el = false
  else el = atom.el
  return { el, canEmpty, canNonEmpty }
}

/** Concatenation. A leading assertion does not clear `el`. */
function concatNode(items: EmptyLast[]): EmptyLast {
  if (items.length === 0) return emptyNode()
  const blocked = items.some((p) => !p.canEmpty && !p.canNonEmpty)
  const canEmpty = !blocked && items.every((p) => p.canEmpty)
  const canNonEmpty = !blocked && items.some((p) => p.canNonEmpty)
  return {
    el: !canEmpty || items.every((p) => p.el),
    canEmpty,
    canNonEmpty,
  }
}

/** Alternation. An empty branch before a later non-empty one clears `el`. */
function altNode(branches: EmptyLast[]): EmptyLast {
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
  const canEmpty = branches.some((b) => b.canEmpty)
  const canNonEmpty = branches.some((b) => b.canNonEmpty)
  return {
    el: !canEmpty || (branches.every((b) => b.el) && !emptyThenFull),
    canEmpty,
    canNonEmpty,
  }
}

function repeatOver(parts: readonly Walked[]): boolean {
  return parts.some((p) => p.repeatOver === true)
}

function concatAll(parts: Walked[]): Walked {
  const attr = concatNode(parts.map((p) => p.attr))
  if (isNothing(attr)) return { attr, text: JS_NEVER }
  return { attr, text: parts.map((p) => p.text).join(''), repeatOver: repeatOver(parts) }
}

function emitAlt(branches: Walked[]): Walked {
  const attr = altNode(branches.map((b) => b.attr))
  if (isNothing(attr)) return { attr, text: JS_NEVER }
  const kept = branches.filter((b) => !isNothing(b.attr))
  if (kept.length === 0) return { attr, text: JS_NEVER }
  if (kept.length === 1) return { attr, text: kept[0].text, repeatOver: kept[0].repeatOver }
  return {
    attr,
    text: kept.map((b) => (b.text.length === 0 ? '(?:)' : b.text)).join('|'),
    repeatOver: repeatOver(kept),
  }
}

function unionSpans(parts: readonly (readonly CodeSpan[])[]): CodeSpan[] {
  const flat: CodeSpan[] = []
  for (const part of parts) {
    for (const [lo, hi] of part) flat.push([lo, hi])
  }
  flat.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: CodeSpan[] = []
  for (const span of flat) {
    const last = out[out.length - 1]
    if (!last || span[0] > last[1] + 1) out.push(span)
    else if (span[1] > last[1]) out[out.length - 1] = [last[0], span[1]]
  }
  return out
}

function closed(ctx: WalkContext): Walked {
  ctx.refusals.invalid = true
  return { attr: nothingNode(), text: JS_NEVER }
}

function unexpectedNode(_node: never, ctx: WalkContext): Walked {
  return closed(ctx)
}

function noteSurrogate(value: number, ctx: WalkContext): void {
  if (isSurrogateValue(value)) ctx.refusals.surrogate = true
}

function propertySpans(raw: string, negate: boolean, ctx: WalkContext): readonly CodeSpan[] {
  try {
    const ranges = jsPropertyRanges(raw.slice(3, -1), ctx.ruleName)
    return negate ? complementSpans(ranges) : ranges
  } catch (err) {
    if (err instanceof CustomPatternError) {
      ctx.refusals.invalid = true
      return []
    }
    throw err
  }
}

function spansOfShorthand(kind: 'digit' | 'space' | 'word', negate: boolean): readonly CodeSpan[] {
  const base = kind === 'digit' ? DIGIT_SPANS : kind === 'word' ? WORD_SPANS : JS_SPACE_SPANS
  return negate ? complementSpans(base) : base
}

function emitShorthand(kind: 'digit' | 'space' | 'word', negate: boolean): string {
  if (kind === 'digit') return negate ? '[^0-9]' : '[0-9]'
  const body = formatSpans(kind === 'word' ? WORD_SPANS : JS_SPACE_SPANS)
  return negate ? `[^${body}]` : `[${body}]`
}

function spansOfClassSet(node: AST.CharacterSet, ctx: WalkContext): readonly CodeSpan[] {
  if (node.kind === 'any') {
    ctx.refusals.invalid = true
    return []
  }
  if (node.kind === 'property') {
    if (node.strings) {
      ctx.refusals.invalid = true
      return []
    }
    return propertySpans(node.raw, node.negate, ctx)
  }
  if (node.kind === 'word') ctx.refusals.word = true
  return spansOfShorthand(node.kind, node.negate)
}

function walkClass(node: AST.ClassRangesCharacterClass, ctx: WalkContext): Walked {
  const parts: (readonly CodeSpan[])[] = []
  for (const el of node.elements) {
    switch (el.type) {
      case 'Character':
        noteSurrogate(el.value, ctx)
        parts.push([[el.value, el.value]])
        break
      case 'CharacterClassRange':
        noteSurrogate(el.min.value, ctx)
        noteSurrogate(el.max.value, ctx)
        if (el.min.value > el.max.value) {
          ctx.refusals.invalid = true
          break
        }
        parts.push([[el.min.value, el.max.value]])
        break
      case 'CharacterSet':
        parts.push(spansOfClassSet(el, ctx))
        break
      default:
        return unexpectedNode(el, ctx)
    }
  }
  const spans = unionSpans(parts)
  if (!node.negate) {
    if (spans.length === 0) return { attr: nothingNode(), text: JS_NEVER }
    return { attr: charNode(), text: `[${formatSpans(spans)}]` }
  }
  if (spans.length === 0) return { attr: charNode(), text: JS_ANY }
  if (complementSpans(spans).length === 0) return { attr: nothingNode(), text: JS_NEVER }
  return { attr: charNode(), text: `[^${formatSpans(spans)}]` }
}

function flagsAfterGroup(node: AST.Group, flags: FlagState, ctx: WalkContext): FlagState {
  const mods = node.modifiers
  if (!mods) return flags
  let ignoreCase = flags.ignoreCase
  let dotAll = flags.dotAll
  if (mods.add.ignoreCase) {
    ignoreCase = true
    ctx.refusals.caseIgnore = true
  }
  if (mods.add.dotAll) dotAll = true
  if (mods.add.multiline) ctx.refusals.multiline = true
  if (mods.remove?.ignoreCase) ignoreCase = false
  if (mods.remove?.dotAll) dotAll = false
  return { ignoreCase, dotAll }
}

function wrapGroup(text: string, parent: FlagState, child: FlagState): string {
  if (child.ignoreCase === parent.ignoreCase) return `(?:${text})`
  const body = text.length === 0 ? '(?:)' : text
  return child.ignoreCase ? `(?i:${body})` : `(?-i:${body})`
}

function walkAlts(
  alts: readonly AST.Alternative[],
  flags: FlagState,
  ctx: WalkContext,
  budget: number,
): Walked {
  return emitAlt(alts.map((alt) => walkNode(alt, flags, ctx, budget)))
}

/** Largest count of a repeat: its max, or its min when the repeat is open. `{0}` is 0. */
function repeatMax(min: number, max: number): number {
  const m = Number.isFinite(max) ? max : min
  return m > 0 ? m : 0
}

function walkNode(node: AST.Node, flags: FlagState, ctx: WalkContext, budget: number): Walked {
  switch (node.type) {
    case 'Pattern':
    case 'Group': {
      if (node.type === 'Group') {
        const inner = flagsAfterGroup(node, flags, ctx)
        const body = walkAlts(node.alternatives, inner, ctx, budget)
        if (isNothing(body.attr)) return { attr: body.attr, text: JS_NEVER }
        return { attr: body.attr, text: wrapGroup(body.text, flags, inner), repeatOver: body.repeatOver }
      }
      return walkAlts(node.alternatives, flags, ctx, budget)
    }
    case 'CapturingGroup': {
      const body = walkAlts(node.alternatives, flags, ctx, budget)
      if (isNothing(body.attr)) return { attr: body.attr, text: JS_NEVER }
      return { attr: body.attr, text: `(?:${body.text})`, repeatOver: body.repeatOver }
    }
    case 'Alternative':
      return concatAll(node.elements.map((el) => walkNode(el, flags, ctx, budget)))
    case 'Quantifier': {
      if (!Number.isFinite(node.min) || !Number.isFinite(node.max) || node.max < node.min) {
        ctx.refusals.invalid = true
      }
      const m = repeatMax(node.min, node.max)
      // re2js checks every repeat from 1000 on its own. A zero-count repeat
      // only cuts the count coming from outside, so the body starts again at
      // 1000; the nest that walk finds is carried upward as usual.
      const childBudget = m > 0 ? Math.floor(budget / m) : NESTED_REPEAT_BUDGET
      const body = walkNode(node.element, flags, ctx, childBudget)
      const attr = quantify(body.attr, node.min, node.max, !node.greedy, ctx)
      // An unsatisfiable body under `{0,n}` (n ≥ 2) makes re2js throw
      // `unexpected InstFail`. Nothing is rewritten, never quantified.
      if (isNothing(body.attr)) return { attr, text: node.min === 0 ? '(?:)' : JS_NEVER }
      const suffix = node.min === 0 && node.max === 1 ? '?' : `{${node.min},${node.max}}`
      return {
        attr,
        text: body.text + suffix + (node.greedy ? '' : '?'),
        // A zero-count repeat does not hide body.repeatOver: it only cuts
        // the outside count.
        repeatOver: (m > 0 && childBudget === 0) || body.repeatOver === true,
      }
    }
    case 'Character':
      noteSurrogate(node.value, ctx)
      return { attr: charNode(), text: `\\x{${node.value.toString(16)}}` }
    case 'CharacterSet': {
      if (node.kind === 'any') {
        return { attr: charNode(), text: flags.dotAll ? JS_ANY : JS_DOT }
      }
      if (node.kind === 'property') {
        if (node.strings) return closed(ctx)
        const spans = propertySpans(node.raw, node.negate, ctx)
        if (spans.length === 0) return { attr: nothingNode(), text: JS_NEVER }
        return { attr: charNode(), text: `[${formatSpans(spans)}]` }
      }
      if (node.kind === 'word') ctx.refusals.word = true
      return { attr: charNode(), text: emitShorthand(node.kind, node.negate) }
    }
    case 'CharacterClass':
      if (node.unicodeSets) return closed(ctx)
      return walkClass(node, ctx)
    case 'Assertion': {
      if (node.kind === 'lookahead' || node.kind === 'lookbehind') return closed(ctx)
      if (node.kind === 'word') {
        ctx.refusals.word = true
        return { attr: emptyNode(), text: node.negate ? '\\B' : '\\b' }
      }
      return { attr: emptyNode(), text: node.kind === 'start' ? '^' : '$' }
    }
    case 'Backreference':
    case 'CharacterClassRange':
    case 'ClassIntersection':
    case 'ClassStringDisjunction':
    case 'ClassSubtraction':
    case 'ExpressionCharacterClass':
    case 'Flags':
    case 'ModifierFlags':
    case 'Modifiers':
    case 'RegExpLiteral':
      return closed(ctx)
    case 'StringAlternative':
      for (const ch of node.elements) noteSurrogate(ch.value, ctx)
      return closed(ctx)
    default:
      return unexpectedNode(node, ctx)
  }
}

const PROPERTY_BODY_RE = /^[A-Za-z0-9_=]+$/
const UNICODE_LAST = 0x10ffff

/** One entry per raw property body, for the process. */
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
