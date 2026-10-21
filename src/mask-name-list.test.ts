/**
 * Labelled names one per line.
 *
 * The name shape allowed whitespace between words, and a line break is
 * whitespace, so a name could run on into the next line's label. With the
 * label pattern case-insensitive, `name` on the next line read as a third
 * word of the name. That label was then part of the first match, the next
 * name had no label in front of it, and every second name stayed readable:
 * `name: [MASKED_PII]: Mehmet Kaya`.
 *
 * Both pipelines run every case, as in mask-blind-spots.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { Governance } from './governance.js'
import { maskSensitiveText } from './mask-text.js'

const gov = new Governance({})

const PIPELINES: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ['maskSensitiveText', (text) => maskSensitiveText(text)],
  ['Governance.maskPII', (text) => String(gov.maskPII(text).masked)],
]

const LISTS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['English label, LF', 'name: Ahmet Yılmaz\nname: Mehmet Kaya\nname: Ali Can\n', ['Ahmet Yılmaz', 'Mehmet Kaya', 'Ali Can']],
  ['customer label', 'customer: John Smith\ncustomer: Jane Doe\n', ['John Smith', 'Jane Doe']],
  [
    'Turkish label, four names',
    'Müşteri: Ayşe Demir\nMüşteri: Fatma Şahin\nMüşteri: Zeynep Kılıç\nMüşteri: Elif Arslan\n',
    ['Ayşe Demir', 'Fatma Şahin', 'Zeynep Kılıç', 'Elif Arslan'],
  ],
  ['CRLF', 'name: Ahmet Yılmaz\r\nname: Mehmet Kaya\r\n', ['Ahmet Yılmaz', 'Mehmet Kaya']],
]

describe('labelled names, one per line', () => {
  for (const [pipeline, mask] of PIPELINES) {
    for (const [label, input, names] of LISTS) {
      it(`${pipeline}: ${label}: no name is readable`, () => {
        const out = mask(input)
        for (const name of names) expect(out).not.toContain(name)
        for (const name of names) for (const word of name.split(' ')) expect(out).not.toContain(word)
      })

      it(`${pipeline}: ${label}: every line keeps its own label`, () => {
        const out = mask(input)
        expect(out.split('\n').length).toBe(input.split('\n').length)
        const labelOf = (line: string) => line.slice(0, line.indexOf(':') + 1)
        const inputLabels = input.split('\n').filter(Boolean).map(labelOf)
        const outLabels = out.split('\n').filter(Boolean).map(labelOf)
        expect(outLabels).toEqual(inputLabels)
      })
    }

    // 0.3.0 masks a name that follows its label or title on the next line.
    // Stopping name words at a line break must not stop the label from
    // reaching across one.
    const NEXT_LINE: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['name:\nAhmet Yılmaz', ['Ahmet', 'Yılmaz']],
      ['Müşteri:\r\nAyşe Demir', ['Ayşe', 'Demir']],
      ['customer:\n  John Smith', ['John', 'Smith']],
      ['Sayın\nAhmet Yılmaz', ['Ahmet', 'Yılmaz']],
    ]
    for (const [input, words] of NEXT_LINE) {
      it(`${pipeline}: value on the line after its label or title: ${JSON.stringify(input)}`, () => {
        const out = mask(input)
        for (const word of words) expect(out).not.toContain(word)
      })
    }

    it(`${pipeline}: a label followed by another label on the next line masks the name and keeps both labels`, () => {
      const out = mask('Name:\nName: Mehmet Kaya')
      expect(out).not.toContain('Mehmet')
      expect(out).not.toContain('Kaya')
      expect(out.split('\n').map((line) => line.slice(0, line.indexOf(':') + 1))).toEqual(['Name:', 'Name:'])
    })

    // A value that happens to be a label word is still a value, as in 0.3.0.
    // Only a label that is followed by its colon is a label.
    const LABEL_WORD_VALUES: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['contact: Name', ['Name']],
      ['name: Customer', ['Customer']],
      ['name: Full Name', ['Full', 'Name']],
      ['Dr. Name', ['Name']],
    ]
    for (const [input, words] of LABEL_WORD_VALUES) {
      it(`${pipeline}: a value that is a label word is masked: ${JSON.stringify(input)}`, () => {
        const out = mask(input)
        for (const word of words) expect(out).not.toContain(word)
      })
    }

    it(`${pipeline}: U+2028 ends a line the way LF does`, () => {
      const input = 'name: Ahmet Yilmaz name: Mehmet Kaya'
      const out = mask(input)
      for (const word of ['Ahmet', 'Yilmaz', 'Mehmet', 'Kaya']) expect(out).not.toContain(word)
      expect(out.split(' ').map((line) => line.slice(0, line.indexOf(':') + 1))).toEqual(['name:', 'name:'])
    })

    it(`${pipeline}: a chain of titles does not leave the name readable`, () => {
      const out = mask('Prof. Dr. Ahmet Yılmaz')
      expect(out).not.toContain('Ahmet')
      expect(out).not.toContain('Yılmaz')
    })
  }
})
