/**
 * Core detector spans and the single merge pass.
 */
import { describe, expect, it } from 'vitest'
import { compileCustomPatterns } from '../custom_patterns.js'
import { luhnOk } from '../digit_pii.js'
import { isTd3Mrz, mrzCheckDigit } from '../mrz.js'
import { apply, detect, type CoreOptions } from './core.js'

function masked(text: string, opts?: CoreOptions): string {
  return apply(text, detect(text, opts).spans).text
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

describe('email', () => {
  it('masks an address and leaves a non-address', () => {
    expect(masked('a@b.com')).toBe('[MASKED_PII]')
    expect(masked('not-an-email')).toBe('not-an-email')
    const hit = detect('say a@b.com please')
    expect(hit.spans.some((s) => s.cls === 'email' && s.start === 4)).toBe(true)
  })

  it('masks an entity-encoded address and leaves a bare encoded at-sign', () => {
    expect(masked('yaz patron&#64;sirket.com')).toBe('yaz [MASKED_PII]')
    expect(masked('yaz patron\\u0040sirket.com')).toBe('yaz [MASKED_PII]')
    expect(masked('5&#64; magaza')).toBe('5&#64; magaza')
    expect(detect('5&#64; magaza').spans.some((s) => s.cls === 'entity-email')).toBe(false)
  })
})

describe('numeric', () => {
  it('masks a card, a TCKN, a phone, and a dashed SSN', () => {
    expect(masked('kart 4111 1111 1111 1111')).toBe('kart [MASKED_PII]')
    expect(masked('kart 4111111111111111')).toBe('kart [MASKED_PII]')
    expect(masked('10000000146')).toBe('[MASKED_PII]')
    expect(masked('05321234567')).toBe('[MASKED_PII]')
    expect(masked('123-45-6789')).toBe('[MASKED_PII]')
    expect(detect('123-45-6789').spans.some((s) => s.cls === 'ssn')).toBe(true)
  })

  it('leaves order numbers, a bare 9-digit run, and a dotted version', () => {
    expect(luhnOk('1234567890123456')).toBe(false)
    expect(masked('ref 1234567890123456')).toBe('ref 1234567890123456')
    expect(masked('siparis 12345678901234567890')).toBe('siparis 12345678901234567890')
    expect(masked('123456789')).toBe('123456789')
    expect(masked('surum 1.2.3.4 derleme 20240131')).toBe('surum 1.2.3.4 derleme 20240131')
    expect(masked('siparis 2024 adet 12 fiyat 149.90')).toBe('siparis 2024 adet 12 fiyat 149.90')
  })

  it('keeps a one-letter tail on a shape-only phone and the whole tail on a checksummed id', () => {
    expect(masked('5321234567a')).toBe('[MASKED_PII]')
    expect(masked('5321234567ab')).toBe('5321234567ab')
    expect(masked('10000000146xy')).toBe('[MASKED_PII]')
  })

  it('finds formatted phones before classifying the neighbouring digit run', () => {
    expect(masked('1234567890 555 123 4567')).toBe('[MASKED_PII] [MASKED_PII]')
    expect(apply('1234567890 555 123 4567', detect('1234567890 555 123 4567').spans).regions).toBe(2)
    expect(masked('12345678901 555 123 4567')).toBe('[MASKED_PII] [MASKED_PII]')
    expect(masked('0532 123 45 67')).toBe('[MASKED_PII]')
    expect(masked('+90 532 123 45 67')).toBe('[MASKED_PII]')
    expect(masked('tel +90 532 123 45 67 ara')).toBe('tel [MASKED_PII] ara')
    expect(detect('+90 532 123 45 67').spans.some((s) => s.cls === 'phone')).toBe(true)
  })

  it('accepts only checksummed group-aligned windows inside a rejected run', () => {
    expect(luhnOk('202410000000146')).toBe(false)
    expect(luhnOk('202402321234567')).toBe(false)
    expect(masked('siparis 2024 10000000146')).toBe('siparis 2024 [MASKED_PII]')
    expect(masked('oda 5 4111 1111 1111 1111')).toBe('oda 5 [MASKED_PII]')
    expect(masked('kod K8 4111 1111 1111 1111')).toBe('kod K8 [MASKED_PII]')
    expect(masked('adet 2 05321234567')).toBe('adet 2 [MASKED_PII]')
    expect(masked('02321234567')).toBe('[MASKED_PII]')
    expect(masked('siparis 2024 02321234567')).toBe('siparis 2024 02321234567')
    expect(masked('siparis 202410000000146')).toBe('siparis 202410000000146')
  })
})

describe('iban', () => {
  it('masks checksum-valid IBANs and leaves an IBAN-shaped word', () => {
    expect(masked('hesap TR330006100519786457841326 tamam')).toBe('hesap [MASKED_PII] tamam')
    expect(masked('GB82 WEST 1234 5698 7654 32')).toBe('[MASKED_PII]')
    expect(masked('referans GB00WEST12345698765432 kayitli')).toBe('referans GB00WEST12345698765432 kayitli')
    expect(detect('referans GB00WEST12345698765432 kayitli').spans.some((s) => s.cls === 'iban')).toBe(false)
  })

  it('finds two IBANs in one sentence', () => {
    const text = 'TR330006100519786457841326 and GB82 WEST 1234 5698 7654 32'
    expect(masked(text)).toBe('[MASKED_PII] and [MASKED_PII]')
  })

  it('does not hide a phone that follows an IBAN-shaped word', () => {
    expect(masked('ref AB12cdef 05321234567')).toBe('ref AB12cdef [MASKED_PII]')
  })
})

describe('mrz', () => {
  const doc = td3('AB1234567', '')
  const personal = td3('L898902C3', '12345678901')
  const ten = td3('L898902C3', '<5321234567')

  it('builds a valid TD3 and masks the block', () => {
    expect(doc.line1).toHaveLength(44)
    expect(doc.line2).toHaveLength(44)
    expect(isTd3Mrz(doc.line1, doc.line2)).toBe(true)
    expect(masked(`pasaport\n${doc.line1}\n${doc.line2}`)).toBe('pasaport\n[MASKED_PII]')
    expect(masked(`pasaport\n${doc.line1}\n${doc.line2}`)).not.toContain('AB1234567')
    expect(masked(`pasaport\r\n${personal.line1}\r\n${personal.line2}`)).not.toContain('12345678901')
    expect(masked(`pasaport\n${ten.line1}\n${ten.line2}`)).not.toContain('5321234567')
  })

  it('masks an email glued to the block and digits glued to the end', () => {
    const gluedMail = `note name@x.c${doc.line1}\n${doc.line2}`
    expect(masked(gluedMail)).toBe('note [MASKED_PII]')
    const tail = doc.line2.match(/\d+$/)?.[0] ?? ''
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.length).toBeLessThanOrEqual(3)
    let suffix = ''
    for (let n = 0; n < 10000 && suffix === ''; n++) {
      const candidate = String(n).padStart(14, '0')
      const run = tail + candidate
      if (run.length >= 13 && run.length <= 16 && luhnOk(run)) suffix = candidate
    }
    expect(suffix).not.toBe('')
    expect(masked(`${doc.line1}\n${doc.line2}${suffix}`)).toBe('[MASKED_PII]')
  })

  it('leaves a checksum failure and honours detectors.mrz false', () => {
    const { line1, line2 } = td3('L898902C3', '')
    const bad = line2.slice(0, 9) + ((Number(line2[9]) + 1) % 10).toString() + line2.slice(10)
    expect(isTd3Mrz(line1, bad)).toBe(false)
    expect(masked(`${line1}\n${bad}`)).toBe(`${line1}\n${bad}`)
    const block = `${line1}\n${line2}`
    expect(masked(block, { detectors: { mrz: false } })).toBe(block)
    expect(detect(block, { detectors: { mrz: false } }).spans.some((s) => s.cls === 'mrz')).toBe(false)
  })
})

describe('ip', () => {
  it('stays off unless detectors.ip is true', () => {
    expect(masked('src 192.0.2.1 dst')).toBe('src 192.0.2.1 dst')
    expect(masked('2001:db8::1')).toBe('2001:db8::1')
    expect(masked('src 192.0.2.1 dst', { detectors: { ip: true } })).toBe('src [MASKED_PII] dst')
    expect(masked('2001:db8::1', { detectors: { ip: true } })).toBe('[MASKED_PII]')
    expect(masked('::1', { detectors: { ip: true } })).toBe('[MASKED_PII]')
    expect(masked('version 1.2.3.4', { detectors: { ip: true } })).toBe('version [MASKED_PII]')
    expect(masked('256.1.1.1', { detectors: { ip: true } })).toBe('256.1.1.1')
    expect(masked('host 11.22.33.44.55', { detectors: { ip: true } })).toBe('host 11.22.33.44.55')
    expect(detect('8.8.8.8').spans.some((s) => s.cls === 'ip')).toBe(false)
  })
})

describe('secrets', () => {
  it('masks the union of both secret patterns', () => {
    expect(masked('sk_live_abc123DEF456')).toBe('[MASKED_SECRET]')
    expect(masked('sk_test_abc123')).toBe('[MASKED_SECRET]')
    expect(masked('sk-proj-ABCDEFGHIJKL')).toBe('[MASKED_SECRET]')
    expect(masked('key is sk-proj_abcDEF123456 now')).toBe('key is [MASKED_SECRET] now')
    expect(masked('AKIAIOSFODNN7EXAMPLE')).toBe('[MASKED_SECRET]')
    expect(masked('sk-short')).toBe('sk-short')
    expect(detect('sk-short').spans.some((s) => s.cls === 'secret')).toBe(false)
  })

  it('masks a connection-string password and not a bare URL', () => {
    expect(masked('postgres://user:parola@db.internal')).toBe('postgres://user:[MASKED_SECRET]')
    expect(masked('postgres://user:hunter2secret@db:5432/x')).toBe('postgres://user:[MASKED_SECRET]@db:5432/x')
    expect(masked('http://example.com/a')).toBe('http://example.com/a')
    const hit = detect('postgres://user:parola@db.internal')
    const span = hit.spans.find((s) => s.cls === 'connection')
    expect(span && 'postgres://user:parola@db.internal'.slice(span.start, span.end)).toBe('parola')
  })

  it('masks seeded bearer tokens, including ones that start like an IBAN', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 200; i++) {
      let seed = 1000 + i * 17
      let token = i % 5 === 0 ? 'xk29' : ''
      while (token.length < 32) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        token += alphabet[seed % alphabet.length]
      }
      expect(masked(`Bearer ${token.slice(0, 32)}`)).toBe('Bearer [MASKED_SECRET]')
    }
  })

  it('keeps the Bearer prefix outside its own span', () => {
    const text = 'Bearer GB00WEST12345698765432'
    const span = detect(text).spans.find((s) => s.cls === 'bearer')
    expect(span).toBeDefined()
    expect(text.slice(0, span?.start)).toBe('Bearer ')
    expect(detect(text).spans.some((s) => s.cls === 'iban')).toBe(false)
    expect(masked(text)).toBe('Bearer [MASKED_SECRET]')
    expect(masked('Bearer abc')).toBe('Bearer abc')
    expect(masked('Bearer ahmet.yilmaz@sirket.com')).toBe('Bearer [MASKED_SECRET]')
    expect(masked('Bearer sk-abcdefghijkl@example.com')).toBe('Bearer [MASKED_SECRET]')
    expect(masked('Bearer 4111111 111111111')).toBe('Bearer [MASKED_SECRET]')
  })

  it('masks the value after a label and stops at the first delimiter', () => {
    expect(masked('api_key=tr33abcdefghijklmnop')).toBe('api_key=[MASKED_SECRET]')
    expect(masked('password: de44xyzw9876543210ab')).toBe('password: [MASKED_SECRET]')
    expect(masked('password: ab')).toBe('password: ab')
    expect(masked('Authorization: Bearer xk29fjQ8sLmP0aZ7rT5w')).toBe(
      'Authorization: [MASKED_SECRET] [MASKED_SECRET]',
    )
    expect(masked('api_key=GB00WEST12345698765432 05321234567')).toBe(
      'api_key=[MASKED_SECRET] [MASKED_PII]',
    )
    expect(masked('password: GB82 WEST 1234 5698 7654 32')).toBe('password: [MASKED_SECRET]')
    expect(masked('pwd: 4111 1111 1111 1111')).toBe('pwd: [MASKED_SECRET]')
    expect(luhnOk('4111111111111112')).toBe(false)
    expect(masked('pwd: 4111 1111 1111 1112')).toBe('pwd: [MASKED_SECRET] 1111 1111 1112')
    expect(masked('api_key": "Wn16ajFynghkzfB6jPVt 05321234567 ve siparis 2024')).toBe(
      'api_key": "[MASKED_SECRET] [MASKED_PII] ve siparis 2024',
    )
  })
})

describe('names', () => {
  it('masks a titled or labelled name and leaves the marker', () => {
    expect(masked('Dr. Ahmet')).toBe('Dr. [MASKED_PII]')
    expect(masked('Sn. Ahmet Yilmaz bugun aradi')).toBe('Sn. [MASKED_PII] bugun aradi')
    expect(masked('Yetkili: Ayse Demir')).toBe('Yetkili: [MASKED_PII]')
    expect(masked('name:Ahmet')).toBe('name:[MASKED_PII]')
    expect(masked('full name:Ahmet')).toBe('full name:[MASKED_PII]')
    expect(masked('Dr.\tAhmet')).toBe('Dr.\t[MASKED_PII]')
    expect(masked('filename: Rapor')).toBe('filename: Rapor')
    expect(masked('Ahmet called yesterday')).toBe('Ahmet called yesterday')
  })

  it('stays off when maskLabelledNames is false', () => {
    expect(masked('Dr. Ahmet', { maskLabelledNames: false })).toBe('Dr. Ahmet')
    expect(detect('Dr. Ahmet', { maskLabelledNames: false }).spans.some((s) => s.cls === 'name')).toBe(false)
  })
})

describe('embedded and whole-field base64', () => {
  const emailB64 = Buffer.from('ahmet@example.com').toString('base64')
  const emailHex = Buffer.from('ahmet@example.com').toString('hex')
  const tcknB64 = Buffer.from('10000000146').toString('base64')
  const ibanB64 = Buffer.from('TR330006100519786457841326').toString('base64')
  const plainB64 = Buffer.from('hello world!!').toString('base64')
  const plainHex = Buffer.from('hello hello hi').toString('hex')

  it('marks a whole-field encoding and an embedded token differently', () => {
    expect(detect(emailB64).wholeField).toEqual({ token: '[MASKED_PII]', reason: 'base64' })
    expect(detect(`\n${emailB64}\n`).wholeField?.token).toBe('[MASKED_PII]')
    expect(detect(tcknB64).wholeField?.reason).toBe('base64')
    expect(detect(ibanB64).wholeField?.token).toBe('[MASKED_PII]')
    expect(detect(plainB64).wholeField).toBeUndefined()
    expect(masked(plainB64)).toBe(plainB64)
    const embedded = detect(`id ${emailB64}`)
    expect(embedded.wholeField).toBeUndefined()
    expect(embedded.spans.some((s) => s.cls === 'embedded')).toBe(true)
    expect(masked(`id ${emailB64}`)).toBe('id [MASKED_PII]')
    expect(masked(`id ${emailHex}`)).toBe('id [MASKED_PII]')
    expect(masked(`ref: ${plainHex}`)).toBe(`ref: ${plainHex}`)
  })

  it('matches 0.2.54 on an id-prefixed hex that happens to pass the IBAN checksum', () => {
    // maskSensitiveText and maskPII both returned [MASKED_PII]69. ID68… satisfies mod-97 by chance.
    expect(masked('id 68656c6c6f2068656c6c6f206869')).toBe('[MASKED_PII]69')
  })
})

describe('custom patterns', () => {
  it('counts unsafe property names on a null-prototype map', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      const compiled = compileCustomPatterns([{ name, pattern: 'zq[0-9]{4}' }])
      const found = detect('zq1234 and zq5678', { customPatterns: compiled })
      expect(found.byClass[name]).toBe(2)
      expect(Object.prototype.hasOwnProperty.call(found.byClass, name)).toBe(true)
      expect(masked('zq1234 and zq5678', { customPatterns: compiled })).toBe('[MASKED_PII] and [MASKED_PII]')
    }
    expect(() => compileCustomPatterns([{ name: '__proto__', pattern: 'zq[0-9]{4}' }])).toThrow()
  })

  it('filters by column and stops later rules after 256 matches', () => {
    const scoped = compileCustomPatterns([{ name: 'hesap', pattern: 'ZZ9', columns: ['*.note'] }])
    expect(masked('ZZ9', { customPatterns: scoped, column: 'public.note' })).toBe('[MASKED_PII]')
    expect(masked('ZZ9', { customPatterns: scoped, column: 'public.iban' })).toBe('ZZ9')
    expect(masked('ZZ9', { customPatterns: scoped })).toBe('ZZ9')

    const exploding = compileCustomPatterns([
      { name: 'empty', pattern: 'a?', label: '[SAFE]' },
      { name: 'bee', pattern: 'b', label: '[B]' },
    ])
    const many = 'b'.repeat(257)
    const found = detect(many, { customPatterns: exploding })
    expect(found.wholeField).toEqual({ token: '[SAFE]', reason: 'empty' })
    expect(found.byClass.empty).toBe(1)
    expect(found.spans.some((s) => s.source === 'bee')).toBe(false)
  })
})

describe('merge', () => {
  it('returns unmerged spans and one region for token plus email', () => {
    const text = 'token: a@b.com'
    const found = detect(text)
    expect(found.spans.filter((s) => s.cls === 'email')).toHaveLength(1)
    expect(found.spans.filter((s) => s.cls === 'labelled-secret')).toHaveLength(1)
    expect(apply(text, found.spans)).toEqual({ text: 'token: [MASKED_SECRET]', regions: 1 })
  })

  it('absorbs a PII prefix before choosing the token', () => {
    expect(masked('x4111111111111111')).toBe('[MASKED_PII]')
    expect(masked('ABC4111111111111111')).toBe('[MASKED_PII]')
    expect(masked('ref_10000000146')).toBe('ref_[MASKED_PII]')
    expect(masked('AB10000000146')).toBe('[MASKED_PII]')
    const compiled = compileCustomPatterns([
      { name: 'id', pattern: '10000000146', label: '[MASKED_SECRET]' },
    ])
    expect(masked('ABC10000000146', { customPatterns: compiled })).toBe('[MASKED_SECRET]')
  })

  it('keeps each detector prefix local', () => {
    expect(masked('token: password:abcd')).toBe('token: [MASKED_SECRET]')
    expect(masked('a@b.com05321234567')).toBe('[MASKED_PII]')
    expect(masked('a@b.com5321234567')).toBe('[MASKED_PII]')
  })

  it('merges adjacent spans into one region and lets the first rule win', () => {
    const first = compileCustomPatterns([
      { name: 'a', pattern: 'a', label: '[A]' },
      { name: 'b', pattern: 'b', label: '[B]' },
    ])
    expect(apply('ab', detect('ab', { customPatterns: first }).spans)).toEqual({ text: '[A]', regions: 1 })
    const second = compileCustomPatterns([
      { name: 'b', pattern: 'b', label: '[B]' },
      { name: 'a', pattern: 'a', label: '[A]' },
    ])
    expect(masked('ab', { customPatterns: second })).toBe('[B]')
    const repeated = compileCustomPatterns([{ name: 'ay', pattern: 'a' }])
    expect(apply('aa', detect('aa', { customPatterns: repeated }).spans).regions).toBe(1)
    expect(apply('a a', detect('a a', { customPatterns: repeated }).spans)).toEqual({
      text: '[MASKED_PII] [MASKED_PII]',
      regions: 2,
    })
  })

  it('scans text that already looks like a mask', () => {
    expect(masked('[MASKED_PII]')).toBe('[MASKED_PII]')
    expect(masked('[MASKED_05321234567]')).toBe('[MASKED_[MASKED_PII]]')
    const foo = compileCustomPatterns([{ name: 'foo', pattern: 'foo' }])
    expect(masked('[MASKED_foo]', { customPatterns: foo })).toBe('[MASKED_[MASKED_PII]]')
  })

  it('runs a custom pattern on the original text and merges it with a built-in span', () => {
    const note = compileCustomPatterns([{ name: 'mail', pattern: 'a@b\\.com', label: '[NOTE]' }])
    const found = detect('see a@b.com now', { customPatterns: note })
    expect(found.spans.some((s) => s.cls === 'email')).toBe(true)
    expect(found.spans.some((s) => s.source === 'mail')).toBe(true)
    expect(masked('see a@b.com now', { customPatterns: note })).toBe('see [MASKED_PII] now')
    const secret = compileCustomPatterns([{ name: 'mail', pattern: 'a@b\\.com', label: '[MASKED_SECRET]' }])
    expect(masked('see a@b.com now', { customPatterns: secret })).toBe('see [MASKED_SECRET] now')
  })

  it('counts one region when a label and a card cover the same value', () => {
    expect(apply('pwd: 4111 1111 1111 1111', detect('pwd: 4111 1111 1111 1111').spans).regions).toBe(1)
  })
})

describe('performance smoke', () => {
  it('masks a 16384-character email run and a 40000-digit run within 500ms', () => {
    const unit = 'a@b.co '
    let emails = ''
    while (emails.length < 16384) emails += unit
    emails = emails.slice(0, 16384)
    const digits = '1'.repeat(40000)
    const started = performance.now()
    apply(emails, detect(emails).spans)
    apply(digits, detect(digits).spans)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
