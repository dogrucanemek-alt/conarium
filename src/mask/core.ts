/**
 * Independent detectors on one normalised string, then one merge pass.
 */
import type { CompiledCustomPattern } from '../custom_patterns.js'
import type { DetectorToggles } from '../types.js'
import { detectBearerSpans } from './detectors/bearer.js'
import { detectConnectionSpans } from './detectors/connection.js'
import { detectCustomPatterns } from './detectors/custom.js'
import { detectEmailSpans } from './detectors/email.js'
import { detectEmbeddedSpans } from './detectors/embedded.js'
import { detectIbanSpans } from './detectors/iban.js'
import { detectIpSpans } from './detectors/ip.js'
import { detectLabelledSecretSpans } from './detectors/labelled_secret.js'
import { detectMrzSpans } from './detectors/mrz.js'
import { detectNameSpans } from './detectors/name.js'
import { detectNumericSpans } from './detectors/numeric.js'
import { detectSecretSpans } from './detectors/secret.js'
import { detectWholeFieldBase64 } from './detectors/whole_base64.js'

export type SpanClass =
  | 'email'
  | 'entity-email'
  | 'phone'
  | 'tckn'
  | 'card'
  | 'ssn'
  | 'iban'
  | 'mrz'
  | 'ip'
  | 'secret'
  | 'connection'
  | 'bearer'
  | 'labelled-secret'
  | 'name'
  | 'embedded'
  | 'custom'

export interface Span {
  start: number
  end: number
  cls: SpanClass
  token: string
  source: string
}

export interface CoreOptions {
  detectors?: DetectorToggles
  customPatterns?: CompiledCustomPattern[]
  column?: string
  maskLabelledNames?: boolean
}

export interface WholeField {
  token: string
  reason: string
}

export interface DetectResult {
  /** Detector ranges before merge. */
  spans: Span[]
  wholeField?: WholeField
  /** Custom-rule counts. Null prototype so names like constructor stay own data. */
  byClass: Record<string, number>
}

const PII = '[MASKED_PII]'
const SECRET = '[MASKED_SECRET]'

function tokenTier(token: string): number {
  if (token === SECRET) return 0
  if (token === PII) return 1
  return 2
}

function preferWhole(a: WholeField | undefined, b: WholeField | undefined): WholeField | undefined {
  if (!a) return b
  if (!b) return a
  return tokenTier(b.token) < tokenTier(a.token) ? b : a
}

function appendSpans(into: Span[], extra: readonly Span[]): void {
  for (let i = 0; i < extra.length; i++) into.push(extra[i])
}

export function detect(normalized: string, opts: CoreOptions = {}): DetectResult {
  const spans: Span[] = []
  appendSpans(spans, detectEmailSpans(normalized))
  appendSpans(spans, detectNumericSpans(normalized))
  appendSpans(spans, detectIbanSpans(normalized))
  if (opts.detectors?.mrz !== false) appendSpans(spans, detectMrzSpans(normalized))
  if (opts.detectors?.ip === true) appendSpans(spans, detectIpSpans(normalized))
  appendSpans(spans, detectSecretSpans(normalized))
  appendSpans(spans, detectConnectionSpans(normalized))
  appendSpans(spans, detectBearerSpans(normalized))
  appendSpans(spans, detectLabelledSecretSpans(normalized))
  if (opts.maskLabelledNames !== false) appendSpans(spans, detectNameSpans(normalized))
  appendSpans(spans, detectEmbeddedSpans(normalized))

  const custom = detectCustomPatterns(normalized, opts.customPatterns, opts.column)
  appendSpans(spans, custom.spans)
  const wholeField = preferWhole(detectWholeFieldBase64(normalized), custom.wholeField)
  return { spans, wholeField, byClass: custom.byClass }
}

interface Piece {
  start: number
  end: number
  token: string
  tier: number
  order: number
}

function expandLeft(text: string, start: number): number {
  let s = start
  while (s > 0) {
    const c = text.charCodeAt(s - 1)
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    if (!alnum) break
    s--
  }
  return s
}

function outranks(next: Piece, cur: Piece): boolean {
  if (next.tier !== cur.tier) return next.tier < cur.tier
  if (next.tier === 2) return next.order < cur.order
  return false
}

export function apply(normalized: string, spans: Span[]): { text: string; regions: number } {
  const items: Piece[] = []
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]
    if (!sp || !sp.token || sp.end < sp.start) continue
    let start = sp.start
    let end = sp.end
    if (start > normalized.length) continue
    if (sp.token === PII) start = expandLeft(normalized, start)
    if (end > normalized.length) end = normalized.length
    if (start < 0) start = 0
    items.push({ start, end, token: sp.token, tier: tokenTier(sp.token), order: i })
  }
  items.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order)

  const merged: Piece[] = []
  for (const it of items) {
    const cur = merged[merged.length - 1]
    if (!cur || it.start > cur.end) {
      merged.push({ ...it })
      continue
    }
    if (it.end > cur.end) cur.end = it.end
    if (outranks(it, cur)) {
      cur.token = it.token
      cur.tier = it.tier
      cur.order = it.order
    }
  }

  let text = ''
  let cursor = 0
  for (const m of merged) {
    if (m.start > cursor) text += normalized.slice(cursor, m.start)
    text += m.token
    if (m.end > cursor) cursor = m.end
  }
  text += normalized.slice(cursor)
  return { text, regions: merged.length }
}
