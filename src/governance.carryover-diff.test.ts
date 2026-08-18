/**
 * Behaviour lock for carry-over masking (redactKnownValues).
 *
 * Written BEFORE any optimisation. Expected output is produced by a frozen
 * copy of the current algorithm. Do not edit the reference to make a new
 * implementation pass.
 */
import { describe, it, expect } from 'vitest'
import { Governance } from './governance.js'
import type { QueryResult } from './types.js'

const MIN_KNOWN_VALUE_LENGTH = 3

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Frozen copy of governance.ts knownValueMatchers + redactKnownValues. */
function referenceRedact(text: string, values: string[]): string {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length >= MIN_KNOWN_VALUE_LENGTH) unique.add(trimmed)
  }
  const matchers = [...unique]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'giu'))
  let out = text
  for (const matcher of matchers) {
    out = out.replace(matcher, '[MASKED_PII]')
  }
  return out
}

function productRedact(text: string, values: string[]): string {
  const gov = new Governance({
    maskColumns: values.map((_, i) => `*.v${i}`),
  })
  const row: Record<string, unknown> = { _table: 'public.t', note: text }
  values.forEach((v, i) => {
    row[`v${i}`] = v
  })
  const result: QueryResult = {
    rows: [row],
    rowCount: 1,
    fields: Object.keys(row),
  }
  const out = gov.redact(result)
  return String(out.rows[0].note)
}

const CORPUS: { name: string; values: string[]; text: string }[] = [
  {
    name: 'longer value first — no leftover surname',
    values: ['Ayse Demir', 'Demir'],
    text: 'Ayse Demir siparisi verdi, Demir teyit etti',
  },
  {
    name: 'substring: short name inside a longer Turkish word',
    values: ['Ali'],
    text: 'Kalite kontrolu tamam, Ali onayladi',
  },
  {
    name: 'Turkish dotted/dotless i and s-cedilla as letters, not boundaries',
    values: ['Ali', 'ışık', 'şımarık'],
    text: 'Kalite ve ışık iyi; şımarık degil. Ali geldi.',
  },
  {
    name: 'g-breve is a letter',
    values: ['Ege'],
    text: 'Ege geldi, yegane karar o',
  },
  {
    name: 'nested values — longest sequential pass',
    values: ['abc def', 'abc', 'def'],
    text: 'xx abc def yy abc zz def',
  },
  {
    name: 'overlap where longest-first ≠ leftmost (abc vs bc def)',
    values: ['abc', 'bc def'],
    text: 'abc def',
  },
  {
    name: 'later longer phrase vs earlier shorter — sequential longest-first',
    values: ['bar baz extra', 'foo bar'],
    text: 'foo bar baz extra',
  },
  {
    name: 'punctuation and parentheses neighbours',
    values: ['Ali'],
    text: '(Ali), Ali. Ali; "Ali" /Ali/ [Ali]',
  },
  {
    name: 'newline neighbour',
    values: ['Ali'],
    text: 'bas\nAli\nson',
  },
  {
    name: 'same value many times',
    values: ['Ada'],
    text: 'Ada Ada Ada ve Ada',
  },
  {
    name: 'empty text',
    values: ['Ada'],
    text: '',
  },
  {
    name: 'value shorter than 3 is not carried',
    values: ['AB'],
    text: 'AB serisi koltuk',
  },
  {
    name: 'very long value',
    values: ['A'.repeat(200)],
    text: `prefix ${'A'.repeat(200)} suffix`,
  },
  {
    name: 'regex metacharacters in the value',
    values: ['a+b*', 'x.y'],
    text: 'literal a+b* and x.y not aaby',
  },
]

describe('carry-over corpus — product matches frozen reference', () => {
  for (const item of CORPUS) {
    it(item.name, () => {
      const expected = referenceRedact(item.text, item.values)
      const got = productRedact(item.text, item.values)
      expect(got).toBe(expected)
    })
  }
})

describe('carry-over — unique-email bench shape stays bit-identical', () => {
  it('80 distinct emails: notes without the value stay verbatim; a planted leak is still carried', () => {
    const n = 80
    const emails = Array.from({ length: n }, (_, i) =>
      i === 0 ? 'bench-secret-user@example.com' : `user-${i + 1}@example.com`,
    )
    const gov = new Governance({ maskColumns: ['*.email'], maxRows: 100 })
    const rows = emails.map((email, i) => ({
      id: i + 1,
      name: `user-${i + 1}`,
      email,
      note: i === 7 ? `contact ${email} please` : `note ${i + 1}`,
    }))
    const out = gov.redact({
      rows,
      rowCount: n,
      fields: ['id', 'name', 'email', 'note'],
    })
    expect(out.governance.maskedCount).toBe(n + 1)
    expect(out.governance.byClass ?? {}).toEqual({})
    expect(out.governance.maskedFields).toEqual(['email', 'note'])
    expect(out.rows[7].note).toBe('contact [MASKED_PII] please')
    expect(out.rows[7].note).toBe(referenceRedact(String(rows[7].note), emails))
    for (let i = 0; i < n; i++) {
      if (i === 7) continue
      expect(out.rows[i].note).toBe(`note ${i + 1}`)
      expect(out.rows[i].email).toBe('[MASKED_PII]')
    }
  })
})
