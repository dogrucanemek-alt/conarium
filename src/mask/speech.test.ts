/**
 * The speech pipeline: text that a local speech model wrote from a recording.
 * Digits come split by hyphens and spaces and the @ of an address can be lost,
 * so its rules are harsher than the text pipeline's, and the text pipeline
 * does not move. Inputs are real large-v3-turbo transcripts of synthetic
 * Turkish recordings that carry test values only (test/fixtures/speech).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { maskField } from '../mask-text.js'
import type { SpanClass } from './core.js'

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
    for (const value of ['TR-33-1-50', '1005-1978', '8-4-23-26', '05-3-123-45-67', 'aysen.tyilmaz.example.com']) {
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
    for (const run of ['123 456', '12-34-56', '123456']) {
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

describe('speech pipeline: the text pipeline does not move', () => {
  it('masks the same transcript exactly as before', () => {
    expect(maskField(fixture(SPOKEN_NUMBERS), { pipeline: 'text' }).text).toBe(
      "Merhaba, kimlik numaram [MASKED_PII], Ayban'ım [MASKED_PII]457-8413-26. Mail adresim ayşe.yılmaz.example.com, telefonum [MASKED_PII].",
    )
  })
})
