/**
 * Operator patterns on the original text, in rule order, with a column filter.
 */
import {
  CUSTOM_PATTERN_MAX_MATCHES,
  columnMatches,
  type CompiledCustomPattern,
} from '../../custom_patterns.js'
import type { Span, WholeField } from '../core.js'

export interface CustomDetect {
  spans: Span[]
  wholeField?: WholeField
  byClass: Record<string, number>
}

function addOwn(bag: Record<string, number>, key: string, n: number): void {
  const prev = Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : 0
  Object.defineProperty(bag, key, {
    value: prev + n,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

export function detectCustomPatterns(
  text: string,
  compiled: CompiledCustomPattern[] | undefined,
  column: string | undefined,
): CustomDetect {
  const byClass: Record<string, number> = Object.create(null)
  if (!compiled || compiled.length === 0) return { spans: [], byClass }
  const spans: Span[] = []
  for (const rule of compiled) {
    if (rule.columns.length > 0) {
      if (!column || !columnMatches(rule.columns, column)) continue
    }
    const ranges = rule.matches(text)
    if (ranges.length > CUSTOM_PATTERN_MAX_MATCHES) {
      addOwn(byClass, rule.name, 1)
      return { spans, wholeField: { token: rule.label, reason: rule.name }, byClass }
    }
    if (ranges.length === 0) continue
    addOwn(byClass, rule.name, ranges.length)
    for (const range of ranges) {
      spans.push({
        start: range.start,
        end: range.end,
        cls: 'custom',
        token: rule.label,
        source: rule.name,
      })
    }
  }
  return { spans, byClass }
}
