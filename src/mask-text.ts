/**
 * Shared PII/secret masking pipeline. Audit args, error text, and (later)
 * reason/target/governance all go through this — one copy, not three.
 */
import { normalizePiiText } from './pii_normalize.js'
import { resolveScanCharCap } from './digit_pii.js'
import type { CompiledCustomPattern } from './custom_patterns.js'
import type { DetectorToggles } from './types.js'
import { apply, detect, type Span, type SpanClass } from './mask/core.js'
import { beltCover } from './mask/belt.js'
import { detectSpeechSpans } from './mask/speech.js'

export interface MaskTextOptions {
  scanCharCap?: number
  detectors?: DetectorToggles
  customPatterns?: CompiledCustomPattern[]
}

export const SECRET_VALUE_RE =
  /\b(?:sk-[A-Za-z0-9]{12,}|sk_live_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g

export function maskSecretShapedValues(text: string, token = '[MASKED_SECRET]'): string {
  SECRET_VALUE_RE.lastIndex = 0
  return text.replace(SECRET_VALUE_RE, token)
}

const SECRET = '[MASKED_SECRET]'
const PII = '[MASKED_PII]'

export interface MaskFieldOptions extends MaskTextOptions {
  pipeline: 'text' | 'governance' | 'speech'
  column?: string
  maskLabelledNames?: boolean
  only?: readonly SpanClass[]
}

function tokenTier(token: string): number {
  if (token === SECRET) return 0
  if (token === PII) return 1
  return 2
}

function preferToken(
  left: string | undefined,
  right: string | undefined,
  rules: readonly { label: string }[],
): string | undefined {
  if (!left) return right
  if (!right) return left
  const a = tokenTier(left)
  const b = tokenTier(right)
  if (a !== b) return a < b ? left : right
  if (a < 2) return left
  const ia = rules.findIndex((rule) => rule.label === left)
  const ib = rules.findIndex((rule) => rule.label === right)
  if (ia < 0) return ib < 0 ? left : right
  if (ib < 0) return left
  return ia <= ib ? left : right
}

function legacySpan(start: number, end: number): Span {
  return {
    start,
    end,
    cls: 'legacy',
    token: PII,
    source: 'belt',
  } as unknown as Span
}

/** Belt ranges carry no token. Only the part a core span does not already cover enters as PII. */
function beltOnlySpans(core: readonly Span[], belt: readonly { start: number; end: number }[]): Span[] {
  const raw: { start: number; end: number }[] = []
  for (let i = 0; i < core.length; i++) {
    const sp = core[i]
    if (sp.end > sp.start) raw.push({ start: sp.start, end: sp.end })
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const iv = raw[i]
    const cur = merged[merged.length - 1]
    if (!cur || iv.start > cur.end) merged.push({ start: iv.start, end: iv.end })
    else if (iv.end > cur.end) cur.end = iv.end
  }

  const ordered = unionBelt(beltByStart(belt))
  const out: Span[] = []
  // `head` only moves forward. Belt ranges are in start order, so an interval
  // that ended before this range cannot meet a later one.
  let head = 0
  for (let b = 0; b < ordered.length; b++) {
    const sp = ordered[b]
    if (sp.end <= sp.start) continue
    while (head < merged.length && merged[head].end <= sp.start) head++
    let cursor = sp.start
    for (let k = head; k < merged.length; k++) {
      const iv = merged[k]
      if (iv.start >= sp.end) break
      if (iv.start > cursor) out.push(legacySpan(cursor, Math.min(iv.start, sp.end)))
      if (iv.end > cursor) cursor = iv.end
      if (cursor >= sp.end) break
    }
    if (cursor < sp.end) out.push(legacySpan(cursor, sp.end))
  }
  return out
}

// Widest ranges of an ambiguous mask overlap. Cut the gaps once, on the
// union, or each range rebuilds the same gaps and the piece count squares.
function unionBelt(
  ordered: readonly { start: number; end: number }[],
): readonly { start: number; end: number }[] {
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) return mergeBelt(ordered)
  }
  return ordered
}

function mergeBelt(
  ordered: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = []
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

function beltByStart(
  belt: readonly { start: number; end: number }[],
): readonly { start: number; end: number }[] {
  for (let i = 1; i < belt.length; i++) {
    if (belt[i].start < belt[i - 1].start) {
      const copy = belt.slice()
      copy.sort((a, b) => a.start - b.start)
      return copy
    }
  }
  return belt
}

function ownByClass(src: Record<string, number> | undefined): Record<string, number> {
  const bag: Record<string, number> = Object.create(null)
  if (!src) return bag
  for (const key of Object.keys(src)) {
    const n = src[key]
    if (typeof n !== 'number' || !(n > 0)) continue
    Object.defineProperty(bag, key, {
      value: n,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return bag
}

function emptyBag(): Record<string, number> {
  return Object.create(null)
}

function addCount(bag: Record<string, number>, key: string, n = 1): void {
  if (!(n > 0)) return
  const prev = Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : 0
  Object.defineProperty(bag, key, {
    value: prev + n,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function countClasses(spans: readonly Span[]): Record<string, number> {
  const bag = emptyBag()
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].end > spans[i].start) addCount(bag, spans[i].cls)
  }
  return bag
}

function countMasked(core: readonly Span[], beltOnly: readonly Span[]): Record<string, number> {
  const bag = emptyBag()
  for (let i = 0; i < core.length; i++) {
    if (core[i].end > core[i].start) addCount(bag, core[i].cls)
  }
  for (let i = 0; i < beltOnly.length; i++) {
    if (beltOnly[i].end > beltOnly[i].start) addCount(bag, 'unclassified')
  }
  return bag
}

function wholeMasked(): Record<string, number> {
  const bag = emptyBag()
  addCount(bag, 'whole')
  return bag
}

// A speech span that overlaps a span of its own class widens it; otherwise
// it is added. Walking every kept span for every extra one is quadratic:
// 40 000 dotted addresses spent two seconds in that inner loop. Sort by
// class and start, then merge in one pass.
function absorbSpeech(spans: Span[], extra: readonly Span[]): void {
  if (extra.length === 0) return
  for (let e = 0; e < extra.length; e++) spans.push(extra[e])
  mergeSameClass(spans)
}

function mergeSameClass(spans: Span[]): void {
  if (spans.length < 2) return
  spans.sort((a, b) => (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : a.start - b.start || a.end - b.end))
  let w = 0
  for (let r = 1; r < spans.length; r++) {
    const cur = spans[w]
    const nxt = spans[r]
    if (cur.cls === nxt.cls && nxt.start < cur.end) {
      if (nxt.end > cur.end) cur.end = nxt.end
    } else {
      w++
      spans[w] = nxt
    }
  }
  spans.length = w + 1
}

function coreToApply(spans: readonly Span[], only: readonly SpanClass[] | undefined): readonly Span[] {
  if (!only) return spans
  const allow = new Set(only)
  const out: Span[] = []
  for (let i = 0; i < spans.length; i++) {
    if (allow.has(spans[i].cls)) out.push(spans[i])
  }
  return out
}

function wholeFieldResult(
  text: string,
  byClass: Record<string, number>,
  classes: Record<string, number>,
): {
  text: string
  count: number
  byClass: Record<string, number>
  classes: Record<string, number>
  masked: Record<string, number>
} {
  return { text, count: 1, byClass, classes, masked: wholeMasked() }
}

// The core detects on its own. The belt keeps every span 0.2.54 masked.
// When the belt cannot decide, the whole field is masked.
export function maskField(text: string, opts: MaskFieldOptions): {
  text: string
  count: number
  byClass: Record<string, number>
  classes: Record<string, number>
  masked: Record<string, number>
} {
  if (text.length > resolveScanCharCap(opts.scanCharCap)) {
    return wholeFieldResult(PII, emptyBag(), emptyBag())
  }
  try {
    const normalized = normalizePiiText(text)
    const rules = opts.customPatterns ?? []
    const detected = detect(normalized, {
      detectors: opts.detectors,
      customPatterns: rules,
      column: opts.column,
      maskLabelledNames: opts.maskLabelledNames,
    })
    let speechUnclassified: { start: number; end: number }[] = []
    if (opts.pipeline === 'speech') {
      const found = detectSpeechSpans(normalized)
      absorbSpeech(detected.spans, found.classified)
      speechUnclassified = found.unclassified
    }
    const belt = beltCover({
      raw: text,
      normalized,
      pipeline: opts.pipeline === 'governance' ? 'governance' : 'text',
      policy: {
        detectors: opts.detectors,
        scanCharCap: opts.scanCharCap,
        maskLabelledNames: opts.maskLabelledNames,
      },
      customPatterns: rules,
      column: opts.column,
      scanCharCap: opts.scanCharCap,
    })
    const byClass = ownByClass(detected.byClass)
    const classes = countClasses(detected.spans)
    if (!belt.ok) return wholeFieldResult(PII, byClass, classes)
    const whole = preferToken(detected.wholeField?.token, belt.wholeField, rules)
    if (whole) return wholeFieldResult(whole, byClass, classes)
    const coreApplied = coreToApply(detected.spans, opts.only)
    const beltRanges = speechUnclassified.length === 0
      ? belt.spans
      : belt.spans.concat(speechUnclassified)
    const beltOnly = beltOnlySpans(detected.spans, beltRanges)
    const applied = apply(normalized, coreApplied.concat(beltOnly))
    return {
      text: applied.text,
      count: applied.regions,
      byClass,
      classes,
      masked: countMasked(coreApplied, beltOnly),
    }
  } catch {
    return wholeFieldResult(PII, emptyBag(), emptyBag())
  }
}

// The core detects on its own. The belt keeps every span 0.2.54 masked.
// When the belt cannot decide, the whole field is masked.
export function maskSensitiveText(text: string, opts: MaskTextOptions = {}): string {
  return maskField(text, {
    pipeline: 'text',
    scanCharCap: opts.scanCharCap,
    detectors: opts.detectors,
    customPatterns: opts.customPatterns,
  }).text
}
