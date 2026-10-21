// Covers the source spans implied by a frozen 0.2.54 mask, or refuses the field.
import { maskSensitiveText } from './legacy_0254/legacy_mask_text.js'
import {
  legacyMaskPiiString,
  maskByColumnName,
  type LegacyMaskOpts,
} from './legacy_0254/legacy_governance_mask.js'
import {
  columnMatches,
  CUSTOM_PATTERN_MAX_MATCHES,
  matchCustomPatternSource,
  type CompiledCustomPattern,
} from '../custom_patterns.js'
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

let alignCalls = 0

export function alignCallCount(): number {
  return alignCalls
}

export function resetAlignCalls(): void {
  alignCalls = 0
}

export function alignRegions(
  source: string,
  output: string,
  tokens: string[],
  mode: 'plain' | 'trim',
): { ok: true; spans: BeltSpan[] } | { ok: false; reason: string } {
  const budget = new Budget(1_000_000_000)
  try {
    const aligned = mode === 'plain'
      ? alignOutput(source, output, tokens, budget)
      : alignTrimmed(source, output, tokens, budget)
    if (!aligned.ok) return aligned
    return { ok: true, spans: unionOverlaps(aligned.spans) }
  } catch (err) {
    if (err instanceof BudgetExceeded) return { ok: false, reason: 'budget' }
    return { ok: false, reason: 'exception' }
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

  if (stepped.text === input.normalized) return { ok: true, spans: [], added: 0 }
  const aligned = alignTrimmed(input.normalized, stepped.text, tokens, budget)
  if (!aligned.ok) return aligned
  const spans = unionOverlaps(
    dropExactLabels(
      input.normalized,
      trimSpanEdges(input.normalized, splitAtLineBreaks(input.normalized, aligned.spans)),
    ),
  )
  return { ok: true, spans, added: spans.length }
}

// Frozen 0.2.54 name shape treats a line break as a word gap, so a mask can
// end on the next line's label. That label is not a value; keep the line.
function splitAtLineBreaks(source: string, spans: BeltSpan[]): BeltSpan[] {
  const out: BeltSpan[] = []
  for (let s = 0; s < spans.length; s++) {
    const sp = spans[s]
    let start = sp.start
    for (let i = sp.start; i < sp.end; i++) {
      const c = source.charCodeAt(i)
      if (c === 10 || c === 13) {
        if (start < i) out.push({ start, end: i })
        start = i + 1
      }
    }
    if (start < sp.end) out.push({ start, end: sp.end })
  }
  return out
}

function dropExactLabels(source: string, spans: BeltSpan[]): BeltSpan[] {
  const kept: BeltSpan[] = []
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]
    if (isExactLabel(source, sp.start, sp.end)) continue
    kept.push(sp)
  }
  return kept
}

function isExactLabel(source: string, start: number, end: number): boolean {
  let lo = start
  let hi = end
  while (lo < hi && isWs(source[lo])) lo++
  while (hi > lo && isWs(source[hi - 1])) hi--
  if (lo >= hi) return true
  const lower = source.slice(lo, hi).toLowerCase()
  for (let i = 0; i < LABELS.length; i++) {
    if (LABELS[i] === lower) return true
  }
  return false
}

// Repeated titles fit many placements, so the widest range of each token
// overlaps the next. Gaps inside those ranges are built per token, and the
// work grows with the square of the mask count. Overlaps become one range.
function unionOverlaps(spans: BeltSpan[]): BeltSpan[] {
  if (spans.length < 2) return spans
  let ordered = spans
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].start) {
      ordered = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end)
      break
    }
  }
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) return mergeOverlaps(ordered)
  }
  return ordered === spans ? spans : ordered
}

function mergeOverlaps(ordered: BeltSpan[]): BeltSpan[] {
  const merged: BeltSpan[] = []
  for (let i = 0; i < ordered.length; i++) {
    const sp = ordered[i]
    if (sp.end <= sp.start) continue
    const cur = merged[merged.length - 1]
    if (cur && sp.start < cur.end) {
      if (sp.end > cur.end) cur.end = sp.end
    } else {
      merged.push({ start: sp.start, end: sp.end })
    }
  }
  return merged
}

// A space is not a value. A span that starts on one is glued to the word
// on its left, and apply then swallows that word.
function trimSpanEdges(source: string, spans: BeltSpan[]): BeltSpan[] {
  const kept: BeltSpan[] = []
  for (let i = 0; i < spans.length; i++) {
    let start = spans[i].start
    let end = spans[i].end
    while (start < end && isWs(source[start])) start++
    while (end > start && isWs(source[end - 1])) end--
    if (start < end) kept.push({ start, end })
  }
  return kept
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
  const seen = new Set<string>(BUILTIN_TOKENS)
  for (let i = 0; i < rules.length; i++) seen.add(rules[i].label)
  const out: string[] = []
  for (const token of seen) out.push(token)
  out.sort((a, b) => b.length - a.length)
  return out
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
    const matches = collectReplaceMatches(current, rule, budget)
    if (matches.length === 0) continue
    if (matches.length > CUSTOM_PATTERN_MAX_MATCHES) {
      return { ok: true, text: rule.label, wholeField: rule.label }
    }
    if (chainHit(current, matches, tokens, exact, budget)) {
      return { ok: false, reason: 'custom-chain' }
    }
    const tracked = applyTracked(current, matches, rule.label, exact)
    current = tracked.text
    exact = tracked.exact
  }
  return { ok: true, text: current }
}

function collectReplaceMatches(text: string, rule: CompiledCustomPattern, budget: Budget): Match[] {
  const found = ruleMatches(rule, text)
  for (let i = 0; i < found.length; i++) budget.tick(1)
  return found
}

function ruleMatches(rule: CompiledCustomPattern, text: string): Match[] {
  if (typeof rule.matches === 'function') return rule.matches(text)
  return matchCustomPatternSource(rule.re.source, text)
}

function chainHit(
  text: string,
  matches: Match[],
  tokens: string[],
  exact: Array<[number, number]>,
  budget: Budget,
): boolean {
  const spans = tokenSpans(text, tokens, budget)
  let i = 0
  let j = 0
  while (i < matches.length && j < spans.length) {
    const match = matches[i]
    const span = spans[j]
    const rel = relate(match.start, match.end, span[0], span[1])
    if (rel === 'overlap') return true
    if (rel === 'adjacent' && !isExact(span, exact)) return true
    if (match.end <= span[0]) i++
    else j++
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
    if (text.charCodeAt(i) !== 91) {
      i++
      continue
    }
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
  return { text: out, exact: inserted.concat(mapped) }
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

interface TokenHit {
  start: number
  end: number
  text: string
}

const LABEL_EDGE = 48

function alignTrimmed(
  source: string,
  output: string,
  tokens: string[],
  budget: Budget,
): { ok: true; spans: BeltSpan[] } | { ok: false; reason: string } {
  const bounds = trimmedBounds(source, output, tokens, budget)
  if (!bounds) return alignOutput(source, output, tokens, budget)
  const aligned = alignOutput(
    source.slice(bounds.srcLo, bounds.srcHi),
    output.slice(bounds.outLo, bounds.outHi),
    tokens,
    budget,
  )
  if (!aligned.ok || bounds.srcLo === 0) return aligned
  const spans: BeltSpan[] = []
  for (let i = 0; i < aligned.spans.length; i++) {
    const span = aligned.spans[i]
    spans.push({ start: span.start + bounds.srcLo, end: span.end + bounds.srcLo })
  }
  return { ok: true, spans }
}

function trimmedBounds(
  source: string,
  output: string,
  tokens: string[],
  budget: Budget,
): { srcLo: number; srcHi: number; outLo: number; outHi: number } | null {
  if (source === output) return null
  let outLo = 0
  const head = Math.min(source.length, output.length)
  while (outLo < head && source.charCodeAt(outLo) === output.charCodeAt(outLo)) {
    budget.tick(1)
    outLo++
  }
  let suffix = 0
  while (
    suffix < source.length - outLo &&
    suffix < output.length - outLo &&
    source.charCodeAt(source.length - 1 - suffix) === output.charCodeAt(output.length - 1 - suffix)
  ) {
    budget.tick(1)
    suffix++
  }
  if (outLo === 0 && suffix === 0) return null
  let outHi = output.length - suffix
  snapTokenEdges(output, tokens, (lo, hi) => {
    outLo = lo
    outHi = hi
  }, outLo, outHi)
  coverDiscardedTokens(output, tokens, budget, (lo, hi) => {
    outLo = lo
    outHi = hi
  }, outLo, outHi)
  outLo = pullLabelEdge(output, outLo, tokens)
  outHi = pushLabelEdge(output, outHi, tokens)
  snapTokenEdges(output, tokens, (lo, hi) => {
    outLo = lo
    outHi = hi
  }, outLo, outHi)
  coverDiscardedTokens(output, tokens, budget, (lo, hi) => {
    outLo = lo
    outHi = hi
  }, outLo, outHi)
  if (outLo < 0) outLo = 0
  if (outHi > output.length) outHi = output.length
  const suffixLen = output.length - outHi
  const srcLo = outLo
  const srcHi = source.length - suffixLen
  if (srcHi < srcLo || outHi < outLo || suffixLen < 0) return null
  if (srcLo === 0 && suffixLen === 0) return null
  return { srcLo, srcHi, outLo, outHi }
}

function snapTokenEdges(
  output: string,
  tokens: string[],
  write: (lo: number, hi: number) => void,
  outLo: number,
  outHi: number,
): void {
  const loHit = tokenCovering(output, outLo, tokens)
  if (loHit) outLo = loHit.start
  const hiHit = tokenCovering(output, outHi, tokens)
  if (hiHit) outHi = hiHit.end
  write(outLo, outHi)
}

function coverDiscardedTokens(
  output: string,
  tokens: string[],
  budget: Budget,
  write: (lo: number, hi: number) => void,
  outLo: number,
  outHi: number,
): void {
  const before = scanTokens(output, 0, outLo, tokens, budget)
  if (before.length > 0) outLo = before[0].start
  const after = scanTokens(output, outHi, output.length, tokens, budget)
  if (after.length > 0) outHi = after[after.length - 1].end
  write(outLo, outHi)
}

function tokenCovering(output: string, index: number, tokens: string[]): { start: number; end: number } | null {
  if (index <= 0 || index >= output.length) return null
  let max = 1
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].length > max) max = tokens[t].length
  }
  const from = Math.max(0, index - max + 1)
  for (let s = from; s < index; s++) {
    if (output.charCodeAt(s) !== 91) continue
    const text = tokens.find((token) => token.length > 0 && output.startsWith(token, s))
    if (!text) continue
    const end = s + text.length
    if (index < end) return { start: s, end }
  }
  return null
}

function scanTokens(
  output: string,
  from: number,
  to: number,
  tokens: string[],
  budget: Budget,
): TokenHit[] {
  const found: TokenHit[] = []
  const end = Math.min(to, output.length)
  let i = Math.max(0, from)
  while (i < end) {
    budget.tick(1)
    if (output.charCodeAt(i) !== 91) {
      i++
      continue
    }
    const text = tokens.find((token) => token.length > 0 && output.startsWith(token, i))
    if (!text) {
      i++
      continue
    }
    found.push({ start: i, end: i + text.length, text })
    i += text.length
  }
  return found
}

function pullLabelEdge(output: string, outLo: number, tokens: string[]): number {
  const found = nextPiiToken(output, outLo, tokens)
  if (!found) return outLo
  const from = Math.max(0, found.start - LABEL_EDGE)
  const at = markerIndex(output.slice(from, found.start), from)
  // endMin sits on the canonical space before [MASKED_PII]. Leaving that
  // space in the trimmed prefix drops it from the span.
  if (at !== null && outLo > at) return at
  return outLo
}

function pushLabelEdge(output: string, outHi: number, tokens: string[]): number {
  const found = nextPiiToken(output, outHi, tokens)
  if (!found || found.start === outHi) return outHi
  const from = Math.max(0, found.start - LABEL_EDGE)
  if (outHi <= from) return outHi
  if (markerIndex(output.slice(from, found.start), from) === null) return outHi
  if (outHi > from && outHi < found.start) return found.start
  return outHi
}

function nextPiiToken(output: string, from: number, tokens: string[]): TokenHit | null {
  const hits = scanTokens(output, from, Math.min(output.length, from + LABEL_EDGE), tokens, new Budget(1_000_000))
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].text === '[MASKED_PII]') return hits[i]
  }
  return null
}

function markerIndex(tail: string, tailAt: number): number | null {
  if (labelParts(tail)) {
    const head = tail.slice(0, -2)
    return tailAt + head.length - labelLength(head)
  }
  if (titleParts(tail)) {
    const head = tail.slice(0, -1)
    return tailAt + head.length - titleLength(head)
  }
  return null
}

function alignOutput(
  source: string,
  output: string,
  tokens: string[],
  budget: Budget,
): { ok: true; spans: BeltSpan[] } | { ok: false; reason: string } {
  alignCalls++
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
  const floor = Math.max(0, from)
  for (let at = floor; at <= source.length; at++) {
    budget.tick(1)
    const match = matchLiteral(source, at, lit, budget)
    if (match && match.start >= floor) return match
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
  for (let at = Math.min(endLimit, source.length); at >= 0; at--) {
    budget.tick(1)
    const match = matchLiteral(source, at, lit, budget)
    if (!match || match.endMin > endLimit) continue
    return match
  }
  return null
}
