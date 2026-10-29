/**
 * The speech pipeline: text that a local speech model wrote from a recording.
 * Digits come split by hyphens and spaces and the @ of an address can be lost,
 * so its rules are harsher than the text pipeline's, and the text pipeline
 * does not move. Inputs are real large-v3-turbo transcripts of synthetic
 * Turkish recordings that carry test values only (test/fixtures/speech).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileCustomPatterns } from '../custom_patterns.js'
import { maskField } from '../mask-text.js'
import type { SpanClass } from './core.js'
import { detectSpeechSpans } from './speech.js'

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/speech/${name}`, import.meta.url), 'utf8').trim()
}

function speech(text: string, only?: readonly SpanClass[]) {
  return maskField(text, { pipeline: 'speech', ...(only ? { only } : {}) })
}

const SPOKEN_NUMBERS = 'turbo-spoken-numbers.txt'
const DIGITS = 'turbo-digits.txt'

describe('speech pipeline: measured transcripts', () => {
  it('masks every test value in the transcript of numbers said as words', () => {
    const out = speech(fixture(SPOKEN_NUMBERS)).text
    for (const value of ['1-0-0-0-0-0-0-0-1-4-6', 'TR33', '1978', '6457', '8413-26', 'yılmaz.example.com', '0532-123-4567']) {
      expect(out, `${value} left`).not.toContain(value)
    }
    for (const words of ['Merhaba', 'kimlik numaram', 'Mail adresim', 'telefonum']) {
      expect(out).toContain(words)
    }
  })

  it('names the class of each value it masked there', () => {
    const res = speech(fixture(SPOKEN_NUMBERS))
    expect(res.classes.tckn).toBe(1)
    expect(res.classes.iban).toBe(1)
    expect(res.classes.email).toBe(1)
    expect(res.classes.phone).toBe(1)
  })

  it('in the transcript of numbers written as digits, masks the runs it can see and keeps the rest', () => {
    const out = speech(fixture(DIGITS)).text
    for (const value of ['TR-33-1-50', '1005-1978', '05-3-123-45-67', 'aysen.tyilmaz.example.com']) {
      expect(out, `${value} left`).not.toContain(value)
    }
    for (const words of ['müşterimizin', 'numaralı', 'Bu ay ciromuz', '1.200']) {
      expect(out).toContain(words)
    }
  })
})

describe('speech pipeline: the rules', () => {
  it('masks a run of 7 or more digits split by spaces or hyphens, without a checksum', () => {
    for (const run of ['123 45 67', '12-34-567', '1234567', '1 2 3 4 5 6 7']) {
      const out = speech(`numara ${run} tamam`).text
      expect(out, run).not.toMatch(/\d/)
      expect(out).toContain('numara')
      expect(out).toContain('tamam')
    }
  })

  it('leaves a run of 6 digits', () => {
    // 8-4-23-26 is the six-digit tail of an IBAN the model broke apart: below
    // the run length, it is a leak this pipeline does not close.
    for (const run of ['123 456', '12-34-56', '123456', '8-4-23-26']) {
      expect(speech(`kod ${run} tamam`).text).toBe(`kod ${run} tamam`)
    }
  })

  it('reads TR followed by digits as an IBAN, to the end of the run', () => {
    const res = speech('IBAN TR-33-1-50 1005 1978 sonra')
    expect(res.text).not.toMatch(/\d/)
    expect(res.text).toContain('sonra')
    expect(res.classes.iban).toBe(1)
  })

  it('reads a spoken et or at and nokta as an address', () => {
    for (const said of ['ayşe nokta yılmaz et example nokta com', 'ali at firma nokta com nokta tr']) {
      const res = speech(`mail adresim ${said} yazın`)
      expect(res.text, said).not.toContain('example')
      expect(res.text, said).not.toContain('firma')
      expect(res.text).toContain('mail adresim')
      expect(res.text).toContain('yazın')
      expect(res.classes.email).toBe(1)
    }
  })

  it('reads a name.surname.domain.tld run as an address', () => {
    const res = speech('adres ayşe.yılmaz.example.com olsun')
    expect(res.text).toBe('adres [MASKED_PII] olsun')
    expect(res.classes.email).toBe(1)
  })

  it('masks a classified value only when its class is asked for, and an unclassified run always', () => {
    const res = speech('TC 1-0-0-0-0-0-0-0-1-4-6, kod 1005-1978', ['email'])
    expect(res.text).toContain('1-0-0-0-0-0-0-0-1-4-6')
    expect(res.text).not.toContain('1005-1978')
  })
})

describe('speech pipeline: what it leaves alone', () => {
  it('leaves amounts, times, years and dates', () => {
    for (const text of [
      'Toplam 1.250.000 lira',
      'tutar 1.250,00 TL',
      'saat 14:30',
      '2026 yılında',
      'tarih 28-10-2026',
      'tarih 28.10.2026',
      'tarih 28 10 2026',
      '2025-2026 yılları',
      '2025 2026 arası',
      '3 kişi geldi',
    ]) {
      expect(speech(text).text, text).toBe(text)
    }
  })

  it('does not read a domain or a host name as an address', () => {
    for (const text of ['site conarium.ai', 'www.example.com adresi', 'docs.conarium.ai sayfası']) {
      expect(speech(text).text, text).toBe(text)
    }
  })

  it('needs a domain ending before it reads et as @', () => {
    for (const text of ['kontrol et lütfen', 'Ali et yedi', 'bunu not et nokta koy']) {
      expect(speech(text).text, text).toBe(text)
    }
  })
})

describe('speech pipeline: an IBAN needs digits', () => {
  it('does not read TR with fewer than four digits as an IBAN', () => {
    for (const text of ['Model TR 2 geldi', 'TR 100 kodu', 'tr-12 hattı']) {
      expect(speech(text).text, text).toBe(text)
    }
  })
})

describe('speech pipeline: time is linear in the text', () => {
  it('a long nokta chain before many et words takes well under a second', () => {
    const words: string[] = []
    for (let i = 0; i < 3_000; i++) words.push(i % 2 ? 'nokta' : 'a')
    words.push('zz', 'p')
    for (let i = 0; i < 1_500; i++) words.push('q', 'et')
    const t = performance.now()
    detectSpeechSpans(words.join(' '))
    expect(performance.now() - t).toBeLessThan(1_000)
  })

  it('forty thousand dotted addresses through maskField take well under a second', () => {
    const text = 'a.b.c.com '.repeat(40_000)
    const t = performance.now()
    const res = maskField(text, { pipeline: 'speech', scanCharCap: 1_048_576 })
    expect(performance.now() - t).toBeLessThan(1_000)
    expect(res.masked.whole ?? 0).toBe(0)
    expect(res.classes.email).toBe(40_000)
  })

  it('an et word before a long nokta chain without a domain ending takes well under a second', () => {
    const words = ['x', 'et']
    for (let i = 0; i < 20_000; i++) words.push(i % 2 ? 'a' : 'nokta')
    const t = performance.now()
    detectSpeechSpans(words.join(' '))
    expect(performance.now() - t).toBeLessThan(1_000)
  })
})

describe('speech pipeline: mixed and Turkish-cased addresses', () => {
  it('reads an ending written with a Turkish capital İ', () => {
    for (const said of ['mail ali.yilmaz.conarium.Aİ', 'mail ali et conarium nokta Aİ']) {
      const res = speech(said)
      expect(res.text, said).toBe('mail [MASKED_PII]')
      expect(res.classes.email, said).toBe(1)
    }
  })

  it('reads an address that mixes written dots and spoken nokta on either side of et', () => {
    for (const said of [
      'mail ayşe.yılmaz et example nokta com',
      'mail ayşe nokta yılmaz et example.com',
      'mail ayşe.yılmaz et example.com',
    ]) {
      const res = speech(`${said} yazın`)
      expect(res.text, said).toBe('mail [MASKED_PII] yazın')
      expect(res.classes.email, said).toBe(1)
    }
  })

  it('reads an address whose spoken et the speech model glued to a mailbox provider', () => {
    // A real large-v3-turbo transcript: "... et gmail nokta com" came out as one dotted run.
    for (const said of ['ZAKDIRIZUTDURU.ETGMAIL.COM', 'ali.atoutlook.com', 'ayse.yilmaz.ethotmail.com.tr']) {
      const res = speech(`Mailim ${said} Telefonum`)
      expect(res.text, said).toBe('Mailim [MASKED_PII] Telefonum')
      expect(res.classes.email, said).toBe(1)
    }
    expect(speech('Mailim rapor.etiket.com Telefonum').text).toBe('Mailim rapor.etiket.com Telefonum')
  })

  it('does not read the Turkish word biz past another ending on a spoken chain', () => {
    expect(speech('mail ali et example nokta com nokta Biz geldik').text).toBe('mail [MASKED_PII] nokta Biz geldik')
  })

  it('reads biz as an ending in a dotted run and on a spoken chain with no other ending', () => {
    for (const said of [
      'mail ali.yilmaz.firma.biz',
      'mail ali et firma nokta biz',
      'mail ali et firma.biz',
      'mail ali nokta yilmaz et firma nokta biz',
    ]) {
      const res = speech(`${said} yazın`)
      expect(res.text, said).toBe('mail [MASKED_PII] yazın')
      expect(res.classes.email, said).toBe(1)
    }
  })
})

describe('speech pipeline: endings and operator patterns', () => {
  it('reads a spoken or dotted address ending in a common newer domain', () => {
    for (const said of ['mail ayse nokta yilmaz et example nokta dev', 'mail ayse.yilmaz.example.app']) {
      const res = speech(said)
      expect(res.text, said).not.toContain('example')
      expect(res.classes.email, said).toBe(1)
    }
  })

  it('leaves operator patterns as the text pipeline masks and counts them', () => {
    const customPatterns = compileCustomPatterns([
      { name: 'FIRST', pattern: 'bc' },
      { name: 'SECOND', pattern: 'abc' },
    ])
    const text = 'abc 1234567890'
    const plain = maskField(text, { pipeline: 'text', customPatterns })
    const spoken = maskField(text, { pipeline: 'speech', customPatterns })
    expect(spoken.text).toBe(plain.text)
    expect(spoken.classes.custom).toBe(plain.classes.custom)
  })
})

describe('speech pipeline: the text pipeline does not move', () => {
  it('masks the same transcript exactly as before', () => {
    expect(maskField(fixture(SPOKEN_NUMBERS), { pipeline: 'text' }).text).toBe(
      "Merhaba, kimlik numaram [MASKED_PII], Ayban'ım [MASKED_PII]457-8413-26. Mail adresim ayşe.yılmaz.example.com, telefonum [MASKED_PII].",
    )
  })
})
