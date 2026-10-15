/**
 * Shared PII/secret masking pipeline. Audit args, error text, and (later)
 * reason/target/governance all go through this — one copy, not three.
 */
import { normalizePiiText } from './pii_normalize.js'
import { resolveScanCharCap } from './digit_pii.js'
import type { CompiledCustomPattern } from './custom_patterns.js'
import type { DetectorToggles } from './types.js'
import { apply, detect, type Span } from './mask/core.js'
import { beltCover } from './mask/belt.js'

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
  pipeline: 'text' | 'governance'
  column?: string
  maskLabelledNames?: boolean
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

// The core detects on its own. The belt keeps every span 0.2.54 masked.
// When the belt cannot decide, the whole field is masked.
export function maskField(text: string, opts: MaskFieldOptions): {
  text: string
  count: number
  byClass: Record<string, number>
} {
  if (text.length > resolveScanCharCap(opts.scanCharCap)) {
    return { text: PII, count: 1, byClass: Object.create(null) }
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
    const belt = beltCover({
      raw: text,
      normalized,
      pipeline: opts.pipeline,
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
    if (!belt.ok) return { text: PII, count: 1, byClass }
    const whole = preferToken(detected.wholeField?.token, belt.wholeField, rules)
    if (whole) return { text: whole, count: 1, byClass }
    const applied = apply(normalized, detected.spans.concat(beltOnlySpans(detected.spans, belt.spans)))
    return { text: applied.text, count: applied.regions, byClass }
  } catch {
    return { text: PII, count: 1, byClass: Object.create(null) }
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
