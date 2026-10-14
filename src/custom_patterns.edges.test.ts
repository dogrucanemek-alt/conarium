/**
 * Corners where a linear-time engine and JavaScript's backtracking `u`-flag
 * RegExp part ways unless the translation handles them: surrogate-pair escapes,
 * empty and full classes, `[\b]`, case-insensitive `\w`, and a repeated group
 * whose body would rather match nothing than something.
 */
import { describe, expect, it } from 'vitest'
import { compileCustomPatterns } from './custom_patterns.js'

const B = String.fromCharCode(92)
const cp = (...xs: number[]) => String.fromCodePoint(...xs)
const HIGH = String.fromCharCode(0xd83d)
const LOW = String.fromCharCode(0xde00)
const GRIN = cp(0x1f600)
const GRIN2 = cp(0x1f601)
const KELVIN = cp(0x212a)
const LONG_S = cp(0x17f)

function viaJs(source: string, text: string): string {
  return [...text.matchAll(new RegExp(source, 'gu'))].map(m => `${m.index}+${m[0].length}`).join(',')
}

function viaEngine(source: string, text: string): string {
  const [rule] = compileCustomPatterns([{ name: 'r', pattern: source, label: '[R]' }])
  return rule.matches(text).map(m => `${m.start}+${m.end - m.start}`).join(',')
}

function same(sources: string[], texts: string[]) {
  for (const source of sources) {
    it(`${JSON.stringify(source)} is accepted and matches like JavaScript`, () => {
      for (const text of texts) {
        expect({ text, got: viaEngine(source, text) }).toEqual({ text, got: viaJs(source, text) })
      }
    })
  }
}

describe('surrogate-pair escapes and edge classes', () => {
  same([
    `[${B}uD83D${B}uDE00]`, `[^${B}uD83D${B}uDE00]`, `${B}uD83D${B}uDE00?`, `${B}uD83D${B}uDE00{2}`,
    `[${B}uD83D${B}uDE00-${B}uD83D${B}uDE01]`, `${B}u{1F600}`, `[${B}u{1F600}a]`,
    `[${B}b]`, `[^${B}b]`, `[^]`, `[^]{2}`, `[]|a`, `a[]`, `[^a${B}b]`,
  ], [GRIN, GRIN + GRIN, GRIN2, HIGH, LOW, GRIN + LOW, HIGH + GRIN, `a${GRIN}b`, String.fromCharCode(8), 'ab', `a${String.fromCharCode(8)}b`])

  // A surrogate escape that is not half of a `\uHHHH\uLLLL` pair is a lone
  // surrogate to JavaScript, which never matches half of a pair; the engine
  // matches it inside a pair. Such a pattern is refused.
  for (const source of [`${B}u{D83D}${B}u{DE00}`, `${B}uD83D${B}u{DE00}`, `${B}u{D83D}${B}uDE00`, `(?:${B}uD83D)${B}uDE00`,
    `[${B}uD83D]`, `${B}uDE00`, `[^${B}u{D83D}]`, `a${B}uD83D`, `[${B}uD800-${B}uDBFF]`]) {
    it(`${JSON.stringify(source)} is refused, and the reason names the surrogate`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/surrogate/)
    })
  }
  // Classes whose set holds surrogates by property or by a wide range agree.
  same([`${B}p{Cs}`, `[${B}u0000-${B}uFFFF]`, `[^${B}u0061]`, `${B}P{L}`],
    [GRIN, `a${GRIN}`, HIGH, LOW, GRIN + LOW])
})

const modifierGroups = (() => {
  try {
    new RegExp('(?i:a)', 'u')
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!modifierGroups)('case-insensitive groups', () => {
  // Letters fold the same way in both engines, the Kelvin sign and the long s
  // included.
  same([
    '(?i:k)', '(?i:s)', '(?i:K)', '(?i:i)', '(?i:[a-z])', '(?i:[^a-z])', `(?i:${cp(0x3c3)})`, `(?i:${cp(0x130)})`,
    `(?i:a)${B}d`, `(?-i:${B}w)`, `(?i:[a-z]{2})`,
  ], [KELVIN, LONG_S, 'k', 's', 'K', 'S', `a${KELVIN}b`, `${LONG_S}a`, cp(0x130), cp(0x131), 'i', 'I', cp(0x3c3, 0x3c2, 0x3a3), '_1', 'a1'])

  // With a case-insensitive group anywhere in the pattern, V8's \w and \b also
  // take the Kelvin sign and the long s, outside the group as well (Node 24:
  // `(?i:a)\w` matches a, Kelvin sign). The engine's word characters are ASCII,
  // so such a pattern is refused rather than matched differently.
  for (const source of [`(?i:${B}w)`, `(?i:${B}W)`, `(?i:[${B}w])`, `(?i:[^${B}W])`, `(?i:a)${B}w`, `${B}w(?i:a)`,
    `(?i:${B}bk)`, `(?i:${B}Bk)`, `(?i:a)${B}b`, `(?is:x)|[${B}w]`, `(?i-s:a)${B}W`]) {
    it(`${JSON.stringify(source)} is refused, and the reason names word characters`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/word/)
    })
  }
})

describe('a repeated group that prefers to match nothing', () => {
  // JavaScript rejects an optional iteration that matches the empty string and
  // backtracks into the group for a longer choice; the engine takes the empty
  // choice. Where the group lists an empty choice before a non-empty one, the
  // pattern is refused.
  for (const source of ['(?:|a)?', '(?:a??)?', '(?:a?|b)?', '(?:(?:)|a)?', '(?:|ab)?', '(?:|a)?b?', '(?:|a)?a',
    '(?:a??){1,2}', '(?:b|a??)?', `(?:${B}b|a)?`]) {
    it(`${JSON.stringify(source)} is refused, and the reason names the empty choice`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/empty/)
    })
  }
  // Where every empty choice comes after the non-empty ones, the engines agree.
  same(['(?:a|)?', '(?:a?)?', '(?:a?b?)?', `(?:${B}b)?a`, '(?:a?){2}', '(?:a?){1,2}', '(?:a|b?)?', '(?:ab|a?)?', '(?:a|b)??', `(?:a${B}b)?`],
    ['a', 'ab', 'ba', 'aab', 'b', '', 'a b'])
})

describe('forms the refusals must not catch', () => {
  // A group that cannot match the empty string has no empty choice, whatever
  // zero-width parts it holds.
  same([`(?:${B}ba)?`, '(?:^a)?', `(?:${B}b${B}ba|b)?`, `(?:^${B}ba){1,2}`, `(?:a|${B}bb)?`],
    ['a', 'ab', ' a', 'b a', 'aa'])
})

describe.skipIf(!modifierGroups)('modifier text inside a class', () => {
  // `(?i:` inside a class is three literal characters, and `\b` inside a class
  // is a backspace: neither is a case-insensitive group or a word boundary.
  same([`[(?i:)]${B}w`, `(?i:[${B}b])`, `(?i:a)[${B}b]`, `(?i:${B}p{ASCII})`],
    ['(w', 'i', String.fromCharCode(8), `a${String.fromCharCode(8)}`, KELVIN, 'k'])
  for (const source of [`[${B}w](?i:a)`, `(?i:[${B}w])`, `[(]${B}w(?i:a)`]) {
    it(`${JSON.stringify(source)} is still refused`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/word/)
    })
  }
})

describe('a class that holds its own brackets or carets', () => {
  // `[^^]` is a negated class of one caret; what follows it is outside the
  // class and is translated and checked like any other part of the pattern.
  const texts = ['a b', 'aa', `a${String.fromCharCode(0x2028)}`, `a${String.fromCharCode(10)}${String.fromCharCode(0x2028)}`, '] a', '^ a', '[ a']
  same(['[^^].', `[^^]${B}s`, `[^^]${B}S`, `[^^]${B}b`, `[^^]${B}p{ASCII}`, `[^^]${B}P{Any}`,
    `[${B}]]${B}s`, `[^${B}]]${B}s`, `[a${B}[]${B}s`, `[^${B}^]${B}s`, `[${B}^^]${B}s`], texts)
  describe.skipIf(!modifierGroups)('with modifier groups after the class', () => {
    same(['[^^](?s:.)(?-s:.)'], texts)
    for (const [source, reason] of [[`[^^](?i:a)${B}w`, /word/], ['[^^](?m:^a)', /multiline/], [`[${B}]](?i:a)${B}b`, /word/]] as const) {
      it(`${JSON.stringify(source)} is refused`, () => {
        expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(reason)
      })
    }
  })
})

describe('more corners', () => {
  // A raw surrogate in the pattern text is a lone surrogate too.
  for (const source of [HIGH, `[${HIGH}]`, `a${LOW}`]) {
    it(`${JSON.stringify(source)} is refused, and the reason names the surrogate`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/surrogate/)
    })
  }
  // Empty sets inside a class, and an empty class under a quantifier.
  same([`[${B}P{Any}]`, `[^${B}P{Any}]`, `[${B}P{Any}a]`, '[]{0,2}a', '[]?a', '(?:[]|a)?'], ['a', 'ab', ''])
  // Zero-width parts ahead of a greedy optional part leave the empty choice last.
  same(['(?:^a?)?', `(?:${B}ba?)?`, `(?:${B}b${B}ba?b?)?`], ['a', 'ab', ' a', ''])
})

describe('a part that can never match, under a quantifier', () => {
  // Nested or not, and whether the empty set is written or comes from a
  // property, a part that matches nothing under `{0,n}` is the empty match.
  same(['(?:(?:[]){1,2}){0,2}a', '(?:[]x){0,2}a', '(?:x[]){0,2}a', '(?:(?:[]|[])c){0,2}a', '[]{0,1}a',
    `[${B}P{Any}]{0,3}a`, '(?:(?:[]|b)c){0,2}a', '(?:(?:x[]|b)c){1,2}a', '(?:[]|[])?a', '[]{2}a|b'],
  ['a', 'ab', 'bca', 'bcbca', 'xa', ''])
  // A quantified group holding `|` is still refused by the 0.2.54 rule.
  for (const source of ['(?:[]|a){1,2}', '(?:[]|b){0,2}a']) {
    it(`${JSON.stringify(source)} is refused as unsafe`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/unbounded or nested/)
    })
  }
})

describe('nested repeats', () => {
  // The engine refuses repeats nested so that their largest counts multiply
  // past 1000. Up to 1000 the pattern is accepted and matches like JavaScript;
  // past it the refusal names nested quantifiers, not an invalid expression.
  same(['(?:(?:a{25})){40}', '(?:(?:a{2,25})){40}', '(?:(?:a{0,25})){40}'], ['a'.repeat(999), 'a'.repeat(1000), 'a'.repeat(1001), 'b'])
  // A repeat whose largest count is zero matches only the empty string; what
  // it holds does not count against the repeats around it. A nest inside it
  // is still checked on its own (below).
  same(['(?:(?:(?:a{64})){0}){16}', '(?:(?:(?:a{64})){0,0}){16}', '(?:x(?:(?:a{64})){0}|b){16}'], ['a'.repeat(70), 'xb', ''])
  // A count of zero hides what it holds from the repeats around it, but a nest
  // inside it is still checked on its own, from a fresh budget.
  for (const source of ['(?:(?:a{32})){32}', '(?:(?:a{25})){41}', '(?:(?:a{2,25})){41}', '(?:(?:a?){64}){16}',
    '(?:(?:a{0,16})){63}', '(?:x(?:a{32})|b){32}', '(?:(?:a{0}){64}){16}', '(?:(?:(?:a{64})){16}){0}',
    '(?:x(?:(?:a{64})){16}|b){0,0}']) {
    it(`${JSON.stringify(source)} is refused as nested quantifiers`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern: source }])).toThrow(/unbounded or nested/)
    })
  }
})

describe.skipIf(!modifierGroups)('letters V8 folds by the subject string', () => {
  // Inside `(?i:…)`, V8 lets these seven letters match their Latin-1 case
  // partners only when the subject holds a character beyond Latin-1. The engine
  // always does: a documented over-mask, never a leak.
  const WIDE = cp(0x4e00)
  for (const [letter, partners] of [
    [0x178, [0xff]], [0x17f, [0x53, 0x73]], [0x39c, [0xb5]], [0x3bc, [0xb5]],
    [0x1e9e, [0xdf]], [0x212a, [0x4b, 0x6b]], [0x212b, [0xc5, 0xe5]],
  ] as const) {
    const source = `(?i:${cp(letter)})`
    it(`${JSON.stringify(source)} matches its Latin-1 partners in any subject`, () => {
      for (const partner of partners) {
        expect(viaEngine(source, cp(partner))).toBe('0+1')
        expect(viaEngine(source, WIDE + cp(partner))).toBe(viaJs(source, WIDE + cp(partner)))
      }
    })
  }
})
