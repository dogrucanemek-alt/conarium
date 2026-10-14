/**
 * The connection-string credential expression, done in linear time.
 *
 * `/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g` tries every
 * start inside a long run of scheme characters and scans to the end of the run
 * each time: 200 000 letters before one "://" take about twenty seconds. The
 * replacement must give the same text and call the replacer with the same
 * groups, in the same order, as `String.prototype.replace` with that
 * expression, for every input.
 */
import { describe, expect, it } from 'vitest'
import { replaceConnectionCredentials } from './legacy_0254/conn_linear.js'

const RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g

function viaRegex(text: string): { text: string; calls: string[] } {
  const calls: string[] = []
  const out = text.replace(RE, (_m, p1: string, p2: string) => {
    calls.push(`${p1}|${p2}`)
    return `${p1}[MASKED_SECRET]${p2}`
  })
  return { text: out, calls }
}

function viaLinear(text: string): { text: string; calls: string[] } {
  const calls: string[] = []
  const out = replaceConnectionCredentials(text, (p1, p2) => {
    calls.push(`${p1}|${p2}`)
    return `${p1}[MASKED_SECRET]${p2}`
  })
  return { text: out, calls }
}

let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const ALPHABET = ['a', 'B', '1', '+', '.', '-', ':', '/', '@', ' ', '"', "'", 'x', '\t', '_', 'p', 's']

describe('replaceConnectionCredentials matches the expression', () => {
  const fixed = [
    'postgres://user:parola@db.internal',
    'mongodb+srv://u:p4ss@h/db',
    'x postgres://a:b@c and mysql://d:e@f',
    'a1://b:c@d', '1a://b:c@d', '+a://b:c@d', 'ab-c.d+e://u:p@h',
    'http://host/path', 'http://user@host', 'http://user:@host', 'http://:p@host',
    'aaa://u:p:q@h', 'a://u:p@h@i', 'a://u:p @h', 'a://u:p/@h',
    'scheme://u:p@h scheme://u2:p2@h2', 'a://u:a://v:w@x@y',
    '://u:p@h', 'a:/u:p@h', '', 'no scheme here',
    `${'m'.repeat(50)}://u:p@h`, `m${' '.repeat(3)}a://u:p@h`,
  ]
  for (const input of fixed) {
    it(`fixed: ${JSON.stringify(input).slice(0, 40)}`, () => {
      expect(viaLinear(input)).toEqual(viaRegex(input))
    })
  }

  it('200 000 random short inputs over the characters the expression cares about', () => {
    let mismatches = 0
    const first: string[] = []
    for (let i = 0; i < 200_000; i++) {
      const n = 1 + Math.floor(rnd() * 40)
      let s = ''
      for (let k = 0; k < n; k++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
      if (rnd() < 0.5) s = s.slice(0, Math.floor(rnd() * s.length)) + '://' + s.slice(Math.floor(rnd() * s.length))
      const a = viaRegex(s)
      const b = viaLinear(s)
      if (a.text !== b.text || a.calls.join('\n') !== b.calls.join('\n')) {
        mismatches++
        if (first.length < 5) first.push(JSON.stringify(s))
      }
    }
    expect(first).toEqual([])
    expect(mismatches).toBe(0)
  })
})

describe('replaceConnectionCredentials is linear', () => {
  it('a million letters before one scheme separator take well under a second', () => {
    const s = `${'m'.repeat(1_000_000)} x://u:p@h`
    const t = performance.now()
    const out = viaLinear(s)
    expect(performance.now() - t).toBeLessThan(1_000)
    expect(out.text.endsWith('x://u:[MASKED_SECRET]@h')).toBe(true)
  })

  it('a million characters of separators and scheme characters stay linear', () => {
    const s = 'a://'.repeat(250_000)
    const t = performance.now()
    viaLinear(s)
    expect(performance.now() - t).toBeLessThan(1_000)
  })
})
