/**
 * What the rewritten masking engine has to hold.
 *
 * Two kinds of case. "Still masked" cases are protected by 0.2.54 today, some
 * of them only as a side effect of the steps running in sequence; they are
 * green now and must stay green. "Masked from now on" cases are values 0.2.54
 * leaves readable; they are red until the rewrite lands.
 *
 * Every text case runs through both pipelines: `maskSensitiveText` (audit
 * arguments, error text) and `Governance.maskPII` (what the model reads).
 */
import { describe, expect, it } from 'vitest'
import { compileCustomPatterns } from './custom_patterns.js'
import { Governance } from './governance.js'
import { maskSensitiveText } from './mask-text.js'

const gov = new Governance({})

const PIPELINES: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ['maskSensitiveText', (text) => maskSensitiveText(text)],
  ['Governance.maskPII', (text) => String(gov.maskPII(text).masked)],
]

/** The longest run of `value` that is still readable in `out`. */
function longestSurvivingRun(value: string, out: string): number {
  let best = 0
  for (let start = 0; start < value.length; start++) {
    let end = start + best + 1
    while (end <= value.length && out.includes(value.slice(start, end))) {
      best = end - start
      end++
    }
  }
  return best
}

function withCustom(patterns: { name: string; pattern: string; label?: string }[]) {
  const compiled = compileCustomPatterns(patterns)
  const g = new Governance({ customPatterns: patterns })
  return [
    ['maskSensitiveText', (text: string) => maskSensitiveText(text, { customPatterns: compiled })],
    ['Governance.maskPII', (text: string) => String(g.maskPII(text).masked)],
  ] as const
}

describe('G1 — a number glued to the words before it is still found', () => {
  // A neighbouring number joined by one separator turns the run into a length
  // nothing matches, and the whole run is left as it is.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['siparis 2024 10000000146', '10000000146', 'siparis 2024'],
    ['oda 5 4111 1111 1111 1111', '4111 1111 1111 1111', 'oda 5'],
    ['kod K8 4111 1111 1111 1111', '4111 1111 1111 1111', 'kod K8'],
    ['adet 2 05321234567', '05321234567', 'adet 2'],
  ]
  for (const [name, mask] of PIPELINES) {
    for (const [input, value, context] of cases) {
      it(`${name}: ${input}`, () => {
        const out = mask(input)
        expect(longestSurvivingRun(value.replace(/ /g, ''), out.replace(/ /g, ''))).toBeLessThan(4)
        expect(out).toContain(context)
      })
    }
  }
})

describe('G2 — an IBAN-shaped word does not hide the words after it', () => {
  for (const [name, mask] of PIPELINES) {
    it(`${name}: ref AB12cdef 05321234567`, () => {
      expect(mask('ref AB12cdef 05321234567')).not.toContain('05321234567')
    })
  }
})

describe('G3 — a Turkish mobile number in 3-3-2-2 groups', () => {
  for (const [name, mask] of PIPELINES) {
    for (const input of ['+90 532 123 45 67', 'tel +90 532 123 45 67 ara']) {
      it(`${name}: ${input}`, () => {
        expect(longestSurvivingRun('5321234567', mask(input).replace(/ /g, ''))).toBeLessThan(4)
      })
    }
  }
})

describe('G7 — a custom pattern that can backtrack without bound is refused when compiled', () => {
  // `(?:a?){22}z` on twenty-two `a` takes seconds and doubles with every
  // character; no per-call budget can stop a single exec. Refuse the shape.
  for (const pattern of ['(?:a?){30}z', '(a?){25}b', '(?:ab?){20}c', '(?:a{0,1}){30}z', '(?:a?b?){12}c']) {
    it(`refuses ${pattern}`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern }])).toThrow()
    })
  }
  for (const pattern of ['(?:abc){2}', 'zq[0-9]{4}', 'CUST-[0-9]{5}', 'a?', 'TR[0-9]{2} ?[0-9]{4}', '(?:INV|FAT)-[0-9]{6}']) {
    it(`still accepts ${pattern}`, () => {
      expect(() => compileCustomPatterns([{ name: 'r', pattern }])).not.toThrow()
    })
  }
})

describe('G6 — a field at the largest scan cap is masked, not thrown on', () => {
  // About 140 000 masks in one field. The scan cap allows it; the engine has
  // to hand back a masked string for it, not a stack overflow.
  const big = 'a@b.co '.repeat(150_000).slice(0, 1_000_000)
  it('maskSensitiveText', () => {
    const out = maskSensitiveText(big, { scanCharCap: 1_048_576 })
    expect(out).not.toContain('a@b.co')
  })
  it('Governance.maskPII', () => {
    const out = String(new Governance({ scanCharCap: 1_048_576 }).maskPII(big).masked)
    expect(out).not.toContain('a@b.co')
  })
})

describe('G5 — an IBAN-shaped run before a real IBAN does not uncover its tail', () => {
  // "er 0532…2024 GB82 WES" passes the IBAN checksum by chance. Taken first
  // and skipped past, it hides where the real IBAN starts, and the real IBAN's
  // tail is left as it is.
  for (const [name, mask] of PIPELINES) {
    it(`${name}: a lookalike that runs into the IBAN`, () => {
      const out = mask('Authorization: Bearer 05321234567 ve siparis 2024 GB82 WEST 1234 5698 7654 32')
      expect(longestSurvivingRun('GB82WEST12345698765432', out.replace(/ /g, ''))).toBeLessThan(4)
    })
  }
})

describe('G4 — a masked region is counted once', () => {
  // A value both a label and a detector cover is one masked value.
  it('token: a@b.com is one region', () => {
    expect(gov.maskPII('token: a@b.com').count).toBe(1)
  })
  it('pwd: and a card behind it is one region', () => {
    expect(gov.maskPII('pwd: 4111 1111 1111 1111').count).toBe(1)
  })
})

describe('S1 — still masked: what the steps in sequence protected', () => {
  it('Governance.maskPII: a name after a title glued to an IBAN', () => {
    const out = String(gov.maskPII('TR330006100519786457841326Dr. Ahmet').masked)
    expect(out).not.toContain('Ahmet')
    expect(out).not.toContain('TR33')
  })
  it('Governance.maskPII: a name after a label glued to an IBAN', () => {
    expect(String(gov.maskPII('TR330006100519786457841326name: Ahmet').masked)).not.toContain('Ahmet')
  })
  for (const input of ['name:Ahmet', 'name :Ahmet', 'full name:Ahmet', 'Dr.\tAhmet']) {
    it(`Governance.maskPII: labelled name ${JSON.stringify(input)}`, () => {
      expect(String(gov.maskPII(input).masked)).not.toContain('Ahmet')
    })
  }
  for (const [name, mask] of PIPELINES) {
    for (const [input, values] of [
      ['1234567890 555 123 4567', ['1234567890', '4567']],
      ['12345678901 555 123 4567', ['12345678901', '4567']],
    ] as const) {
      it(`${name}: two numbers side by side, ${input}`, () => {
        const out = mask(input)
        for (const v of values) expect(out).not.toContain(v)
      })
    }
    it(`${name}: a connection string keeps neither its password nor its host`, () => {
      const out = mask('postgres://user:parola@db.internal')
      expect(out).not.toContain('parola')
      expect(out).not.toContain('db.internal')
    })
    it(`${name}: a phone inside a token-shaped bracket`, () => {
      expect(mask('[MASKED_05321234567]')).not.toContain('05321234567')
    })
    it(`${name}: fullwidth digits`, () => {
      const out = mask('０５３２１２３４５６７')
      expect(out).not.toContain('05321234567')
      expect(out).not.toContain('０５３２１２３４５６７')
    })
  }
  it('maskSensitiveText: over the scan cap before normalising, the field is masked whole', () => {
    expect(maskSensitiveText('​'.repeat(16_385) + 'PRIVATE')).toBe('[MASKED_PII]')
  })
})

describe('S2 — still masked: custom patterns that work on what was already masked', () => {
  for (const [name, mask] of withCustom([{ name: 'tail', pattern: '\\[MASKED_PII\\] PRIVATE' }])) {
    it(`${name}: a rule that matches a mask and the word after it`, () => {
      expect(mask('a@b.com PRIVATE')).not.toContain('PRIVATE')
    })
  }
  for (const [name, mask] of withCustom([{ name: 'masks', pattern: '\\[MASKED_PII\\]' }])) {
    it(`${name}: more than 256 matches of a mask masks the field whole`, () => {
      expect(mask('a@b.co;'.repeat(257) + 'PRIVATE')).not.toContain('PRIVATE')
    })
  }
  for (const [name, mask] of withCustom([
    { name: 'first', pattern: '\\[\\[MASKED_PII\\] PRIVATEY\\]', label: '[XY]' },
    { name: 'second', pattern: '!\\[X', label: '[A]' },
  ])) {
    it(`${name}: a chain of rules that cuts into an earlier label`, () => {
      expect(mask('![a@b.co PRIVATEY]')).not.toContain('PRIVATE')
    })
  }
  for (const [name, mask] of withCustom([{ name: 'empty', pattern: 'a?', label: '[SAFE]' }])) {
    it(`${name}: more than 256 empty matches masks the field whole`, () => {
      expect(mask('b'.repeat(257) + ' PRIVATE')).not.toContain('PRIVATE')
    })
  }
  it('a rule named __proto__ is refused when it is compiled', () => {
    expect(() => compileCustomPatterns([{ name: '__proto__', pattern: 'zq[0-9]{4}' }])).toThrow()
  })
})
