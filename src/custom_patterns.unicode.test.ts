/**
 * Unicode property classes in custom patterns, after the move to a linear-time
 * engine. A pattern 0.2.54 accepted is accepted, and matches what JavaScript's
 * `u`-flag RegExp matches. The exhaustive list is in
 * custom_patterns.unicode_all.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { applyCustomPatterns, compileCustomPatterns } from './custom_patterns.js'

const B = String.fromCharCode(92)
const p = (name: string) => `${B}p{${name}}`
const P = (name: string) => `${B}P{${name}}`

// Greek, Latin with Turkish letters, CJK, digits in three scripts, an emoji,
// no-break space, line break, punctuation. Built from code points so this
// file holds no raw separator or format character.
const SAMPLE = String.fromCodePoint(
  0x3b1, 0x392, 0x20, 0x61, 0x5a, 0xe7, 0x11f, 0x130, 0x20, 0x4e2d, 0x6587, 0x20,
  0x31, 0x661, 0x967, 0x20, 0x1f600, 0xa0, 0x0a, 0x2d, 0x2e, 0x24, 0x20, 0x2163,
)

function viaJs(source: string, input: string): { text: string; count: number } {
  let count = 0
  const text = input.replace(new RegExp(source, 'gu'), () => {
    count++
    return '[R]'
  })
  return { text, count }
}

const ACCEPTED_BY_0254 = [
  'L', 'Lu', 'Ll', 'N', 'Nd', 'Nl', 'P', 'S', 'Z', 'Letter', 'Uppercase_Letter', 'Decimal_Number',
  'Script=Greek', 'sc=Greek', 'Script=Latin', 'sc=Han', 'Script=Arabic',
  'gc=Lu', 'General_Category=Lu', 'gc=Nd',
  'ASCII', 'Any', 'Alphabetic', 'White_Space', 'Emoji',
  'Script_Extensions=Greek', 'scx=Greek', 'scx=Grek', 'sc=Beng',
]

describe('Unicode property classes 0.2.54 accepted', () => {
  for (const name of ACCEPTED_BY_0254) {
    for (const source of [p(name), P(name), `[${p(name)}x]{1,3}`]) {
      it(`${source} is accepted and matches like JavaScript`, () => {
        const compiled = compileCustomPatterns([{ name: 'r', pattern: source, label: '[R]' }])
        const got = applyCustomPatterns(SAMPLE, compiled)
        expect({ text: got.text, count: got.count }).toEqual(viaJs(source, SAMPLE))
      })
    }
  }
})
