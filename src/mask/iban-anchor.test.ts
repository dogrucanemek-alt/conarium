/**
 * Where an IBAN span may start and end. The inputs that found this are a real
 * large-v3-turbo transcript of an operator's own test recording (test values):
 * `numaram 296-…` was read as an IBAN starting at `am`, and both spans ended
 * inside the next word.
 */
import { describe, expect, it } from 'vitest'
import { ibanMod97Ok } from '../iban.js'
import { maskField } from '../mask-text.js'
import { detectIbanSpans } from './detectors/iban.js'

function validIban(country: string, bban: string): string {
  for (let i = 0; i < 100; i++) {
    const n = country + String(i).padStart(2, '0') + bban
    if (ibanMod97Ok(n)) return n
  }
  throw new Error(`no check digits for ${country}+${bban}`)
}

const TR = validIban('TR', '0006100519786457841322')
const DE = 'DE89370400440532013000'
const SAID_TCKN = 'TC kimlik numaram 296-685-27-354 TC kimlik numarası buydu.'
const SAID_IBAN = 'IBAN numaram TR52-004-4755-2580-34 Mailim ZAKDIRIZUTDURU.ETGMAIL.COM Telefonum 0548-880 555-23'

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9]/.test(c)
}

function spansOf(text: string): string[] {
  return detectIbanSpans(text).map((s) => text.slice(s.start, s.end))
}

/** mulberry32: a fixed sequence, so the property below is the same run every time. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'numaram', 'kimlik', 'evde', 'ben', 'de', 'da', 'sipariş', 'tutar', 'fatura', 'seri', 'hesap',
  'TC', 'no', 'ile', 've', 'kodu', 'adına', 'Mailim', 'Telefonum', 'buydu', 'tr', 'ise', 'gelen',
]

function sentence(next: () => number): string {
  const word = () => WORDS[Math.floor(next() * WORDS.length)]
  const digits = Array.from({ length: 7 + Math.floor(next() * 8) }, () => String(Math.floor(next() * 10)))
  const seps = ['-', ' ', '']
  let run = ''
  for (let i = 0; i < digits.length; i++) {
    run += digits[i]
    if (i < digits.length - 1 && next() < 0.3) run += seps[Math.floor(next() * seps.length)]
  }
  return `${word()} ${word()} ${run} ${word()} ${word()} ${word()}`
}

describe('IBAN spans: where they start and end', () => {
  it('does not read a word that ends in two letters, then a digit run, as an IBAN', () => {
    expect(spansOf(SAID_TCKN)).toEqual([])
    // The 0.2.54 belt still masks what 0.2.54 masked (`numaram 296-…-354 TC k`),
    // so the words around the run stay masked; it is no longer counted as an IBAN.
    expect(maskField(SAID_TCKN, { pipeline: 'text' }).classes.iban).toBeUndefined()
  })

  it('a span never ends inside a word or inside a digit run', () => {
    const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
    for (const text of [SAID_TCKN, SAID_IBAN, `IBAN ${TR} Ahmet Yilmaz adina`, `iban ${DE}ABC devam`]) {
      for (const s of detectIbanSpans(text)) {
        const before = text[s.end - 1]
        const after = text[s.end]
        const cut = isAlnum(after) && !(digit(before) && !digit(after))
        expect(cut, `${text} -> ${text.slice(s.start, s.end)}`).toBe(false)
      }
    }
    expect(spansOf(`iban ${DE}ABC devam`)).toEqual([DE])
  })

  it('a valid IBAN followed by words is one span that ends at its last character', () => {
    const grouped = TR.replace(/(.{4})/g, '$1 ').trim()
    for (const iban of [TR, grouped, DE, `${DE.slice(0, 4)}-${DE.slice(4)}`]) {
      expect(spansOf(`IBAN ${iban} Ahmet Yilmaz adina`), iban).toEqual([iban])
    }
  })

  it('keeps a prefix glued to the IBAN', () => {
    expect(spansOf(`acct${TR}`)).toEqual([TR])
    expect(spansOf(`iban:${DE}.`)).toEqual([DE])
  })

  it('sentences with a digit run between words give an IBAN span at most once in a thousand', () => {
    // Before: 223 of these 3000. What is left is a word that is a country code
    // (`no` is Norway) whose exact length passes mod-97 by chance.
    const next = rng(20261029)
    const hits: string[] = []
    for (let i = 0; i < 3000; i++) {
      const text = sentence(next)
      for (const span of spansOf(text)) hits.push(`${text} -> ${span}`)
    }
    expect(hits.length, hits.join('\n')).toBeLessThanOrEqual(3)
  })

  it('a checksum-valid IBAN the strict detector refuses is still masked, by the 0.2.54 belt', () => {
    let unlisted = ''
    for (let i = 0; i < 100 && !unlisted; i++) {
      const n = `QQ${String(i).padStart(2, '0')}370400440532013000`
      if (ibanMod97Ok(n)) unlisted = n
    }
    const shapes = [
      `hesap ${DE}1234 tamam`,
      `acct${DE.slice(0, 2)} ${DE.slice(2, 4)} ${DE.slice(4)} tamam`,
      `hesap ${unlisted} tamam`,
    ]
    for (const text of shapes) {
      expect(spansOf(text), text).toEqual([])
      for (const pipeline of ['text', 'speech'] as const) {
        const out = maskField(text, { pipeline }).text
        expect(out, `${pipeline}: ${text}`).not.toContain(DE.slice(4))
        expect(out, `${pipeline}: ${text}`).not.toContain(unlisted.slice(4))
      }
    }
  })

  it('the transcript: every value is masked and only the real TR run counts as an IBAN', () => {
    const res = maskField(`${SAID_TCKN} ${SAID_IBAN}`, { pipeline: 'speech', only: ['tckn', 'iban', 'email', 'phone'] })
    for (const value of ['296-685-27-354', 'TR52-004-4755-2580-34', '0548-880 555-23']) {
      expect(res.text, value).not.toContain(value)
    }
    expect(res.classes.iban).toBe(1)
  })
})
