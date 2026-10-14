// Covers the source spans implied by a frozen 0.2.54 mask, or refuses the field.
import { maskSensitiveText } from './legacy_0254/legacy_mask_text.js'
import {
  legacyMaskPiiString,
  maskByColumnName,
  type LegacyMaskOpts,
} from './legacy_0254/legacy_governance_mask.js'
import {
  applyCustomPatterns,
  columnMatches,
  CUSTOM_PATTERN_MAX_MATCHES,
  type CompiledCustomPattern,
} from './legacy_0254/custom_patterns.js'
import { resolveScanCharCap } from './legacy_0254/digit_pii.js'
import type { GovernancePolicy } from './legacy_0254/types.js'

const BUILTIN_TOKENS = ['[MASKED_SECRET]', '[MASKED_PII]'] as const
const PRIVATE_OPEN = '\uE000'
const PRIVATE_CLOSE = '\uE001'

const LABELS = [
  'adı soyadı',
  'adi soyadi',
  'ad soyad',
  'full name',
  'müşteri',
  'musteri',
  'yetkili',
  'temsilci',
  'customer',
  'contact',
  'kişi',
  'kisi',
  'name',
]

const TITLES = [
  'Sayın',
  'Sayin',
  'Bayan',
  'Mrs.',
  'Mr.',
  'Ms.',
  'Prof.',
  'Dr.',
  'Av.',
  'Bay',
  'Sn.',
]

export interface BeltSpan {
  start: number
  end: number
}

export interface BeltInput {
  raw: string
  normalized: string
  pipeline: 'text' | 'governance'
  policy?: GovernancePolicy
  customPatterns: CompiledCustomPattern[]
  column?: string
  scanCharCap?: number
  budget?: number
}

export type BeltResult =
  | { ok: true; spans: BeltSpan[]; wholeField?: string; added: number }
  | { ok: false; reason: string }

class BudgetExceeded extends Error {}

class Budget {
  left: number
  constructor(limit: number) {
    this.left = limit
  }
  tick(n = 1): void {
    this.left -= n
    if (this.left < 0) throw new BudgetExceeded()
  }
}

export function beltCover(input: BeltInput): BeltResult {
  try {
    return cover(input)
  } catch (err) {
    if (err instanceof BudgetExceeded) return { ok: false, reason: 'budget' }
    return { ok: false, reason: 'exception' }
  }
}

function cover(input: BeltInput): BeltResult {
  if (hasPrivateUse(input.raw) || hasPrivateUse(input.normalized)) {
    return { ok: false, reason: 'private-use' }
  }

  const policy = input.policy ?? {}
  const capArg = input.scanCharCap ?? policy.scanCharCap
  const budget = new Budget(
    input.budget ?? 64 * (Math.max(input.normalized.length, 1) + input.raw.length + 1),
  )
  budget.tick(1)

  if (input.pipeline === 'governance' && input.column) {
    const named = maskByColumnName(input.column)
    if (named) return whole(named)
  }
  if (input.raw.length > resolveScanCharCap(capArg)) return whole('[MASKED_PII]')

  const legacy = runLegacy(input, policy, capArg)
  const tokens = tokenVocab(input.customPatterns)
  const stepped = applyRules(legacy, input.customPatterns, input.column, tokens, budget)
  if (!stepped.ok) return stepped
  if (stepped.wholeField) return whole(stepped.wholeField)

  const aligned = alignOutput(input.normalized, stepped.text, tokens, budget)
  if (!aligned.ok) return aligned
  return { ok: true, spans: aligned.spans, added: aligned.spans.length }
}

function whole(token: string): BeltResult {
  return { ok: true, spans: [], wholeField: token, added: 1 }
}

function hasPrivateUse(text: string): boolean {
  return text.includes(PRIVATE_OPEN) || text.includes(PRIVATE_CLOSE)
}

function runLegacy(input: BeltInput, policy: GovernancePolicy, capArg: number | undefined): string {
  if (input.pipeline === 'text') {
    return maskSensitiveText(input.raw, {
      scanCharCap: capArg,
      detectors: policy.detectors,
      customPatterns: [],
    })
  }
  const opts: LegacyMaskOpts = {
    policy: { ...policy, scanCharCap: capArg },
    customPatterns: [],
    column: input.column,
  }
  return legacyMaskPiiString(input.raw, opts).masked
}

function tokenVocab(rules: CompiledCustomPattern[]): string[] {
  const labels = rules.map((rule) => rule.label)
  return [...new Set([...BUILTIN_TOKENS, ...labels])].sort((a, b) => b.length - a.length)
}

interface Match {
  start: number
  end: number
}

function applyRules(
  text: string,
  rules: CompiledCustomPattern[],
  column: string | undefined,
  tokens: string[],
  budget: Budget,
): { ok: true; text: string; wholeField?: string } | { ok: false; reason: string } {
  let current = text
  let exact: Array<[number, number]> = []
  for (const rule of rules) {
    budget.tick(1)
    if (rule.columns.length > 0) {
      if (!column || !columnMatches(rule.columns, column)) continue
    }
    const matches = collectReplaceMatches(current, rule.re, budget)
    if (matches.length === 0) continue
    if (chainHit(current, matches, tokens, exact, budget)) {
      return { ok: false, reason: 'custom-chain' }
    }
    const frozen = applyCustomPatterns(current, [rule], column)
    if (matches.length > CUSTOM_PATTERN_MAX_MATCHES) {
      if (frozen.text !== rule.label) return { ok: false, reason: 'exception' }
      return { ok: true, text: rule.label, wholeField: rule.label }
    }
    const tracked = applyTracked(current, matches, rule.label, exact)
    if (tracked.text !== frozen.text) return { ok: false, reason: 'exception' }
    current = tracked.text
    exact = tracked.exact
  }
  return { ok: true, text: current }
}

function collectReplaceMatches(text: string, re: RegExp, budget: Budget): Match[] {
  const compiled = new RegExp(re.source, re.flags)
  const out: Match[] = []
  text.replace(compiled, (...args: unknown[]) => {
    const match = String(args[0])
    budget.tick(1)
    let index = -1
    for (let i = args.length - 1; i >= 1; i--) {
      if (args[i] !== text) continue
      const prev = args[i - 1]
      if (typeof prev === 'number') index = prev
      break
    }
    if (index >= 0) out.push({ start: index, end: index + match.length })
    return match
  })
  return out
}

function chainHit(
  text: string,
  matches: Match[],
  tokens: string[],
  exact: Array<[number, number]>,
  budget: Budget,
): boolean {
  const spans = tokenSpans(text, tokens, budget)
  for (const match of matches) {
    for (const span of spans) {
      const rel = relate(match.start, match.end, span[0], span[1])
      if (rel === 'overlap') return true
      if (rel === 'adjacent' && !isExact(span, exact)) return true
    }
  }
  return false
}

function isExact(span: [number, number], exact: Array<[number, number]>): boolean {
  return exact.some((item) => item[0] === span[0] && item[1] === span[1])
}

function relate(a0: number, a1: number, b0: number, b1: number): 'overlap' | 'adjacent' | 'clear' {
  if (a0 === a1) {
    if (a0 > b0 && a0 < b1) return 'overlap'
    if (a0 === b0 || a0 === b1) return 'adjacent'
    return 'clear'
  }
  if (a0 < b1 && b0 < a1) return 'overlap'
  if (a1 === b0 || b1 === a0) return 'adjacent'
  return 'clear'
}

function tokenSpans(text: string, tokens: string[], budget: Budget): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < text.length) {
    budget.tick(1)
    const tok = tokens.find((token) => token.length > 0 && text.startsWith(token, i))
    if (tok) {
      spans.push([i, i + tok.length])
      i += tok.length
    } else {
      i++
    }
  }
  return spans
}

function applyTracked(
  text: string,
  matches: Match[],
  label: string,
  exact: Array<[number, number]>,
): { text: string; exact: Array<[number, number]> } {
  let out = ''
  let cursor = 0
  const inserted: Array<[number, number]> = []
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    const at = out.length
    out += label
    inserted.push([at, at + label.length])
    cursor = match.end
  }
  out += text.slice(cursor)
  const mapped: Array<[number, number]> = []
  for (const range of exact) {
    if (matches.some((match) => range[0] < match.end && match.start < range[1])) continue
    mapped.push([mapPos(range[0], matches, label), mapPos(range[1], matches, label)])
  }
  return { text: out, exact: [...inserted, ...mapped] }
}

function mapPos(pos: number, matches: Match[], label: string): number {
  let delta = 0
  for (const match of matches) {
    if (match.end <= pos) delta += label.length - (match.end - match.start)
    else break
  }
  return pos + delta
}

type Piece =
  | { kind: 'lit'; text: string; mode: 'exact' | 'label' | 'title' }
  | { kind: 'tok'; text: string }

interface LitMatch {
  start: number
  endMin: number
  endMax: number
}

function alignOutput(
  source: string,
  output: string,
  tokens: string[],
  budget: Budget,
): { ok: true; spans: BeltSpan[] } | { ok: false; reason: string } {
  const pieces = parsePieces(output, tokens, budget)
  const literals = pieces.filter((piece): piece is Extract<Piece, { kind: 'lit' }> => piece.kind === 'lit')
  const earliestEnd = new Array<number>(literals.length).fill(0)
  const latestStart = new Array<number>(literals.length).fill(0)

  const first = matchLiteral(source, 0, literals[0], budget)
  if (!first || first.start !== 0) return { ok: false, reason: 'unaligned' }
  earliestEnd[0] = first.endMin
  latestStart[0] = 0

  const last = literals.length - 1
  const anchored = matchLiteralEnding(source, source.length, literals[last], budget)
  if (!anchored) return { ok: false, reason: 'unaligned' }
  latestStart[last] = anchored.start
  earliestEnd[last] = source.length

  for (let i = last - 1; i >= 1; i--) {
    const found = latestLiteral(source, literals[i], latestStart[i + 1], budget)
    if (!found) return { ok: false, reason: 'unaligned' }
    latestStart[i] = found.start
  }
  for (let i = 1; i < last; i++) {
    const found = earliestLiteral(source, literals[i], earliestEnd[i - 1], budget)
    if (!found) return { ok: false, reason: 'unaligned' }
    earliestEnd[i] = found.endMin
  }
  if (last > 0 && earliestEnd[last - 1] > latestStart[last]) {
    return { ok: false, reason: 'unaligned' }
  }

  const spans: BeltSpan[] = []
  let lit = 0
  for (const piece of pieces) {
    if (piece.kind === 'lit') {
      lit++
      continue
    }
    const start = earliestEnd[lit - 1]
    const end = latestStart[lit]
    if (end < start) return { ok: false, reason: 'unaligned' }
    if (end > start) spans.push({ start, end })
  }
  return { ok: true, spans }
}

function parsePieces(output: string, tokens: string[], budget: Budget): Piece[] {
  const raw: Array<{ kind: 'lit'; text: string } | { kind: 'tok'; text: string }> = []
  let i = 0
  while (i < output.length) {
    budget.tick(1)
    const tok = tokens.find((token) => token.length > 0 && output.startsWith(token, i))
    if (tok) {
      raw.push({ kind: 'tok', text: tok })
      i += tok.length
    } else {
      const prev = raw[raw.length - 1]
      if (prev && prev.kind === 'lit') prev.text += output[i]
      else raw.push({ kind: 'lit', text: output[i] })
      i++
    }
  }
  if (raw.length === 0 || raw[0].kind === 'tok') raw.unshift({ kind: 'lit', text: '' })
  if (raw[raw.length - 1].kind === 'tok') raw.push({ kind: 'lit', text: '' })
  const spaced: typeof raw = []
  for (const piece of raw) {
    if (piece.kind === 'tok' && spaced.length > 0 && spaced[spaced.length - 1].kind === 'tok') {
      spaced.push({ kind: 'lit', text: '' })
    }
    spaced.push(piece)
  }
  const pieces: Piece[] = []
  for (let n = 0; n < spaced.length; n++) {
    const piece = spaced[n]
    if (piece.kind === 'tok') {
      pieces.push(piece)
      continue
    }
    const next = spaced[n + 1]
    const nextTok = next && next.kind === 'tok' ? next.text : null
    pieces.push({ kind: 'lit', text: piece.text, mode: literalMode(piece.text, nextTok) })
  }
  return pieces
}

function literalMode(text: string, nextTok: string | null): 'exact' | 'label' | 'title' {
  if (nextTok !== '[MASKED_PII]') return 'exact'
  if (labelParts(text)) return 'label'
  if (titleParts(text)) return 'title'
  return 'exact'
}

function boundaryOk(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')
}

function labelParts(literal: string): { rigid: string } | null {
  if (!literal.endsWith(': ')) return null
  const head = literal.slice(0, -2)
  const lower = head.toLowerCase()
  for (const label of LABELS) {
    if (!lower.endsWith(label)) continue
    const at = head.length - label.length
    if (!boundaryOk(head, at)) continue
    return { rigid: head }
  }
  return null
}

function titleParts(literal: string): { rigid: string } | null {
  if (!literal.endsWith(' ') || literal.endsWith(': ')) return null
  const head = literal.slice(0, -1)
  for (const title of TITLES) {
    if (!head.endsWith(title)) continue
    const at = head.length - title.length
    if (!boundaryOk(head, at)) continue
    return { rigid: head }
  }
  return null
}

function isWs(ch: string): boolean {
  return /\s/u.test(ch)
}

function matchLiteral(source: string, at: number, lit: Piece & { kind: 'lit' }, budget: Budget): LitMatch | null {
  budget.tick(1)
  if (lit.mode === 'exact') {
    if (lit.text.length === 0) {
      if (at > source.length) return null
      return { start: at, endMin: at, endMax: at }
    }
    if (!source.startsWith(lit.text, at)) return null
    const end = at + lit.text.length
    return { start: at, endMin: end, endMax: end }
  }
  if (lit.mode === 'label') return matchLabel(source, at, lit.text)
  return matchTitle(source, at, lit.text)
}

function matchLabel(source: string, at: number, literal: string): LitMatch | null {
  const parts = labelParts(literal)
  if (!parts) return null
  if (!source.startsWith(parts.rigid, at)) return null
  const labelAt = at + parts.rigid.length - labelLength(parts.rigid)
  if (!markerBoundaryOk(source, labelAt, literal, 'label')) return null
  let cursor = at + parts.rigid.length
  while (cursor < source.length && isWs(source[cursor])) cursor++
  if (source[cursor] !== ':') return null
  const after = cursor + 1
  let endMax = after
  while (endMax < source.length && isWs(source[endMax])) endMax++
  return { start: at, endMin: after, endMax }
}

function labelLength(rigid: string): number {
  const lower = rigid.toLowerCase()
  for (const label of LABELS) {
    if (lower.endsWith(label)) return label.length
  }
  return 0
}

function matchTitle(source: string, at: number, literal: string): LitMatch | null {
  const parts = titleParts(literal)
  if (!parts) return null
  if (!source.startsWith(parts.rigid, at)) return null
  const titleAt = at + parts.rigid.length - titleLength(parts.rigid)
  if (!markerBoundaryOk(source, titleAt, literal, 'title')) return null
  const after = at + parts.rigid.length
  let endMax = after
  while (endMax < source.length && isWs(source[endMax])) endMax++
  return { start: at, endMin: after, endMax }
}

function titleLength(rigid: string): number {
  for (const title of TITLES) {
    if (rigid.endsWith(title)) return title.length
  }
  return 0
}

function markerBoundaryOk(source: string, at: number, literal: string, kind: 'label' | 'title'): boolean {
  if (gluedAfterToken(literal, kind)) return true
  return boundaryOk(source, at)
}

function gluedAfterToken(literal: string, kind: 'label' | 'title'): boolean {
  if (kind === 'label') {
    const parts = labelParts(literal)
    return parts !== null && labelLength(parts.rigid) === parts.rigid.length
  }
  const parts = titleParts(literal)
  return parts !== null && titleLength(parts.rigid) === parts.rigid.length
}

function matchLiteralEnding(
  source: string,
  endAt: number,
  lit: Piece & { kind: 'lit' },
  budget: Budget,
): LitMatch | null {
  budget.tick(1)
  if (lit.mode !== 'exact') {
    for (let start = 0; start <= endAt; start++) {
      budget.tick(1)
      const match = matchLiteral(source, start, lit, budget)
      if (!match) continue
      if (match.endMin <= endAt && endAt <= match.endMax) return { ...match, start }
    }
    return null
  }
  if (lit.text.length === 0) {
    if (endAt > source.length) return null
    return { start: endAt, endMin: endAt, endMax: endAt }
  }
  const start = endAt - lit.text.length
  if (start < 0 || source.slice(start, endAt) !== lit.text) return null
  return { start, endMin: endAt, endMax: endAt }
}

function earliestLiteral(
  source: string,
  lit: Piece & { kind: 'lit' },
  from: number,
  budget: Budget,
): LitMatch | null {
  if (lit.mode === 'exact' && lit.text.length === 0) {
    if (from > source.length) return null
    return { start: from, endMin: from, endMax: from }
  }
  if (lit.mode === 'exact') {
    const at = source.indexOf(lit.text, from)
    budget.tick(Math.max(1, (at < 0 ? source.length : at) - from + lit.text.length))
    if (at < 0) return null
    return { start: at, endMin: at + lit.text.length, endMax: at + lit.text.length }
  }
  for (let at = from; at <= source.length; at++) {
    budget.tick(1)
    const match = matchLiteral(source, at, lit, budget)
    if (match) return match
  }
  return null
}

function latestLiteral(
  source: string,
  lit: Piece & { kind: 'lit' },
  endLimit: number,
  budget: Budget,
): LitMatch | null {
  if (lit.mode === 'exact' && lit.text.length === 0) {
    const start = Math.min(endLimit, source.length)
    return { start, endMin: start, endMax: start }
  }
  if (lit.mode === 'exact') {
    const maxStart = endLimit - lit.text.length
    budget.tick(lit.text.length + 1)
    if (maxStart < 0) return null
    const at = source.lastIndexOf(lit.text, maxStart)
    if (at < 0) return null
    return { start: at, endMin: at + lit.text.length, endMax: at + lit.text.length }
  }
  let best: LitMatch | null = null
  for (let at = 0; at <= endLimit; at++) {
    budget.tick(1)
    const match = matchLiteral(source, at, lit, budget)
    if (!match || match.endMin > endLimit) continue
    if (!best || match.start >= best.start) best = match
  }
  return best
}
