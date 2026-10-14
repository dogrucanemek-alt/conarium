/**
 * Custom patterns give the same matches whatever engine runs them.
 *
 * `applyCustomPatterns` must replace exactly what `String.prototype.replace`
 * with the pattern compiled as `new RegExp(source, 'gu')` replaces, and count
 * the same number of matches, for every pattern `compileCustomPatterns`
 * accepts. Patterns and texts are generated from a small alphabet so that
 * matches, near-misses, overlaps and empty matches all occur.
 */
import { describe, expect, it } from 'vitest'
import { applyCustomPatterns, compileCustomPatterns } from './custom_patterns.js'

let seed = 20261014
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]

// Characters the two engines are known to treat differently by default are in
// both alphabets: line feed, carriage return, no-break space, line separator.
// They are built from code points so the source file holds no raw control or
// separator character.
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NBSP = String.fromCharCode(0xa0)
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const IDEO_SPACE = String.fromCharCode(0x3000)
const BOM = String.fromCharCode(0xfeff)
const ATOMS = ['a', 'b', 'c', '1', '2', '-', '[a-c]', '[0-9]', '[ab12]', '\\d', '\\w', '.', 'ç', '\\b',
  '[^a]', '[^ ]', '\\s', '\\S', '[\\s1]', '[^\\s]', '^', '$',
  '[\\S]', '[^\\S]', '[\\Sa]', '[^\\Sa]', '[a\\s]', '[\\D\\s]', '[\\W]']
// Modifier groups (`(?i:…)`, `(?s:…)`, `(?-s:…)`) need a JavaScript engine that
// supports them; where it does not, the pattern does not compile and is skipped.
const MODIFIERS = ['i', 's', '-s', 'is', 'i-s']
const QUANTS = ['', '', '', '?', '{2}', '{1,3}', '{0,2}']

function atom(depth: number): string {
  if (depth < 2 && rnd() < 0.15) {
    const n = 1 + Math.floor(rnd() * 3)
    const alts = Array.from({ length: n }, () => seq(depth + 1, 1 + Math.floor(rnd() * 3)))
    const head = rnd() < 0.4 ? `(?${pick(MODIFIERS)}:` : '(?:'
    return `${head}${alts.join('|')})`
  }
  return pick(ATOMS)
}

function seq(depth: number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) {
    const a = atom(depth)
    s += a === '\\b' || a === '^' || a === '$' ? a : a + pick(QUANTS)
  }
  return s
}

const TEXT = ['a', 'b', 'c', 'A', '1', '2', '-', ' ', 'ç', 'x', 'é', LF, CR, NBSP, LS, PS, IDEO_SPACE, BOM]
const text = () => Array.from({ length: Math.floor(rnd() * 24) }, () => pick(TEXT)).join('')

function viaJs(source: string, input: string, label: string): { text: string; count: number } {
  let count = 0
  const out = input.replace(new RegExp(source, 'gu'), () => {
    count++
    return label
  })
  return { text: out, count }
}

describe('custom patterns match like String.prototype.replace', () => {
  it('3 000 generated patterns, 12 texts each', { timeout: 120_000 }, () => {
    let compared = 0
    const mismatches: string[] = []
    for (let i = 0; i < 3_000; i++) {
      const source = seq(0, 1 + Math.floor(rnd() * 4))
      let compiled
      try {
        compiled = compileCustomPatterns([{ name: 'r', pattern: source, label: '[R]' }])
      } catch {
        continue
      }
      for (let k = 0; k < 12; k++) {
        const input = text()
        const js = viaJs(source, input, '[R]')
        const got = applyCustomPatterns(input, compiled)
        // More than 256 matches masks the field whole; that rule is tested elsewhere.
        if (js.count > 256) continue
        compared++
        if (got.text !== js.text || got.count !== js.count) {
          if (mismatches.length < 5) mismatches.push(`${source} on ${JSON.stringify(input)}: js ${JSON.stringify(js)} got ${JSON.stringify({ text: got.text, count: got.count })}`)
        }
      }
    }
    expect(mismatches).toEqual([])
    expect(compared).toBeGreaterThan(10_000)
  })
})

describe('the multiline flag has no counterpart in the engine', () => {
  // JavaScript's multiline `^` and `$` also stop at a carriage return and at
  // U+2028 and U+2029; the engine's stop only at a line feed.
  for (const pattern of ['(?m:^a$)', '(?im:^a)', '(?m-s:a$)']) {
    it(`${pattern} is refused, and the reason names the flag`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern }])).toThrow(/multiline|\bm\b/)
    })
  }
})
