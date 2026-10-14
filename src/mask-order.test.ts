/**
 * What the order of the masking steps has to hold.
 *
 * Every case runs through both pipelines: `maskSensitiveText`, which masks
 * audit arguments and error text, and `Governance.maskPII`, whose output is
 * what the model reads. The two are written out separately in the source, so
 * a change made in one and not the other fails here.
 */
import { describe, expect, it } from 'vitest'
import { applyCustomPatterns, compileCustomPatterns } from './custom_patterns.js'
import { luhnOk } from './digit_pii.js'
import { Governance } from './governance.js'
import { maskSensitiveText } from './mask-text.js'
import { isTd3Mrz, mrzCheckDigit } from './mrz.js'

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

function td3(passport: string, personal: string): { line1: string; line2: string } {
  const name = 'ERIKSSON<<ANNA<MARIA'.padEnd(39, '<')
  const line1 = `P<UTO${name}`
  const birth = '740812'
  const expiry = '120415'
  const personalField = personal.padEnd(14, '<')
  const body =
    passport +
    mrzCheckDigit(passport) +
    'UTO' +
    birth +
    mrzCheckDigit(birth) +
    'F' +
    expiry +
    mrzCheckDigit(expiry) +
    personalField +
    mrzCheckDigit(personalField)
  const composite = body.slice(0, 10) + body.slice(13, 20) + body.slice(21)
  return { line1, line2: body + mrzCheckDigit(composite) }
}

describe('M1 — a passport MRZ is masked whole, whatever its fields hold', () => {
  // The expiry date and its check digit are seven digits. A personal number
  // written straight after them makes one longer run; this one is picked so
  // that the fourteen digits together pass the card checksum.
  const expiryAndCheck = `120415${mrzCheckDigit('120415')}`
  let cardLike = ''
  for (let n = 1000000; cardLike === ''; n++) {
    if (luhnOk(`${expiryAndCheck}${n}`)) cardLike = String(n)
  }

  const fixtures: ReadonlyArray<readonly [string, { line1: string; line2: string }]> = [
    ['an eleven-digit personal number', td3('L898902C3', '12345678901')],
    ['an eleven-digit personal number set off by a filler', td3('L898902C3', '<12345678901')],
    ['a ten-digit personal number set off by a filler', td3('L898902C3', '<5321234567')],
    ['a personal number that reads as a card number with the expiry before it', td3('L898902C3', cardLike)],
    ['a document number that starts with two letters and two digits', td3('AB1234567', '')],
    ['both', td3('AB1234567', '<12345678901')],
  ]

  for (const [what, { line1, line2 }] of fixtures) {
    it(`fixture is a valid TD3: ${what}`, () => {
      expect(line1).toHaveLength(44)
      expect(line2).toHaveLength(44)
      expect(isTd3Mrz(line1, line2)).toBe(true)
    })

    for (const [name, mask] of PIPELINES) {
      it(`${name}: ${what}`, () => {
        const out = mask(`pasaport\n${line1}\n${line2}`)
        expect(out).toBe('pasaport\n[MASKED_PII]')
      })

      it(`${name}: ${what}, CRLF`, () => {
        const out = mask(`pasaport\r\n${line1}\r\n${line2}`)
        expect(out).not.toContain('ERIKSSON')
        expect(out).not.toContain(line2.slice(0, 9))
        expect(out).not.toContain('740812')
      })
    }
  }

  it('with the MRZ detector switched off a valid TD3 is left as it is, in both pipelines', () => {
    const { line1, line2 } = td3('L898902C3', 'ZE184226B')
    const block = `${line1}\n${line2}`
    expect(isTd3Mrz(line1, line2)).toBe(true)
    expect(maskSensitiveText(block, { detectors: { mrz: false } })).toBe(block)
    const off = new Governance({ detectors: { mrz: false } })
    expect(off.maskPII(block).masked).toBe(block)
  })

  it('a TD3 that fails its checksum is still not an MRZ', () => {
    const { line1, line2 } = td3('L898902C3', '')
    const bad = line2.slice(0, 9) + ((Number(line2[9]) + 1) % 10).toString() + line2.slice(10)
    expect(isTd3Mrz(line1, bad)).toBe(false)
    for (const [, mask] of PIPELINES) {
      expect(mask(`${line1}\n${bad}`)).toBe(`${line1}\n${bad}`)
    }
  })
})

describe('M2 — what was already masked stays masked, and plain text stays plain', () => {
  const masked: ReadonlyArray<readonly [string, string]> = [
    ['hesap TR330006100519786457841326 tamam', 'TR330006100519786457841326'],
    ['GB82 WEST 1234 5698 7654 32', '5698 7654 32'],
    ['kart 4111 1111 1111 1111', '4111 1111 1111 1111'],
    ['ahmet@example.com', 'ahmet@example.com'],
    ['tel 0532 123 45 67', '123 45 67'],
    ['postgres://user:hunter2secret@db:5432/x', 'hunter2secret'],
    ['Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
    ['ghp_1234567890abcdefghijABCDEFG', '1234567890abcdefghijABCDEFG'],
  ]
  const plain = [
    'siparis 2024 adet 12 fiyat 149.90',
    'The quick brown fox jumps over the lazy dog.',
    'surum 1.2.3.4 derleme 20240131',
    // IBAN-shaped, not a valid IBAN, and nothing calls it a secret: left as it is, and not half-masked.
    'referans GB00WEST12345698765432 kayitli',
  ]

  for (const [name, mask] of PIPELINES) {
    for (const [input, value] of masked) {
      it(`${name}: still masks ${input.slice(0, 24)}`, () => {
        expect(mask(input)).not.toContain(value)
      })
    }
    for (const input of plain) {
      it(`${name}: leaves "${input.slice(0, 24)}" alone`, () => {
        expect(mask(input)).toBe(input)
      })
    }
  }
})

describe('M3 — a custom pattern is counted under its own name, whatever the name', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`applyCustomPatterns: ${name}`, () => {
      const compiled = compileCustomPatterns([{ name, pattern: 'zq[0-9]{4}' }])
      const res = applyCustomPatterns('zq1234 and zq5678', compiled)
      expect(res.count).toBe(2)
      expect(Object.keys(res.byClass)).toEqual([name])
      expect(Object.prototype.hasOwnProperty.call(res.byClass, name)).toBe(true)
      expect(res.byClass[name]).toBe(2)
    })

    it(`Governance.maskPII: ${name}`, () => {
      const g = new Governance({ customPatterns: [{ name, pattern: 'zq[0-9]{4}' }] })
      const res = g.maskPII({ note: 'zq1234', other: 'zq5678' })
      expect(Object.keys(res.byClass)).toEqual([name])
      expect(res.byClass[name]).toBe(2)
    })
  }
})

describe('M4 — a value that is masked on its own is masked behind any label', () => {
  // Each value is masked whole when it stands alone. A secret label, a Bearer
  // prefix or plain words in front of it must not leave part of it readable:
  // the label step takes the first word after the label, and a value written
  // in groups is more than one word.
  const values = [
    'GB82 WEST 1234 5698 7654 32',
    'GB82WEST12345698765432',
    'GB82-WEST-1234-5698-7654-32',
    'TR33 0006 1005 1978 6457 8413 26',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    '4111111111111111',
    '0532 123 45 67',
    '(532) 123-4567',
    '+90 532 123 4567',
    '10000000146',
    'ahmet@example.com',
    '123-45-6789',
  ]
  const wrappers: ReadonlyArray<readonly [string, (value: string) => string]> = [
    ['bare', (value) => value],
    ['words', (value) => `musteri ${value} kayitli`],
    ['password:', (value) => `password: ${value}`],
    ['token=', (value) => `token=${value}`],
    ['secret =', (value) => `secret = ${value}`],
    ['"api_key":', (value) => `{"api_key": "${value}"}`],
    ['Bearer', (value) => `Bearer ${value}`],
    ['Authorization: Bearer', (value) => `Authorization: Bearer ${value}`],
    ['authorization:', (value) => `authorization: ${value}`],
  ]

  for (const [name, mask] of PIPELINES) {
    for (const [label, wrap] of wrappers) {
      it(`${name}: ${label}`, () => {
        const open: string[] = []
        for (const value of values) {
          const out = mask(wrap(value))
          if (longestSurvivingRun(value, out) >= 4) open.push(`${wrap(value)} -> ${out}`)
        }
        expect(open).toEqual([])
      })
    }
  }
})

describe('M5 — the label step still sees what it saw before, and counts a secret once', () => {
  // The IBAN pass sets aside a span that starts at an IBAN-shaped word and runs
  // on through the words after it. While that span is set aside the label step
  // takes it whole; once it is back, the label step takes only its first word.
  const input = 'api_key": "Wn16ajFynghkzfB6jPVt 05321234567 ve siparis 2024'

  for (const [name, mask] of PIPELINES) {
    it(`${name}: a number after an IBAN-shaped token behind a label is not left readable`, () => {
      const out = mask(input)
      expect(out).not.toContain('05321234567')
      expect(out).not.toContain('Wn16ajFynghkzfB6jPVt')
    })
  }

  it('a labelled secret is one masked value in the count', () => {
    expect(gov.maskPII('password: hunter2secret').count).toBe(1)
    // One label and the card covering the same value are one region.
    expect(gov.maskPII('pwd: 4111 1111 1111 1111').count).toBe(1)
  })
})
