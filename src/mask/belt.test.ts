// Checks frozen 0.2.54 copies, belt cover, and brute-force alignment.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { alignCallCount, alignRegions, beltCover, resetAlignCalls, type BeltInput, type BeltSpan } from './belt.js'
import {
  applyCustomPatterns,
  compileCustomPatterns,
  type CompiledCustomPattern,
} from './legacy_0254/custom_patterns.js'
import { legacyMaskPiiNumber, legacyMaskPiiString } from './legacy_0254/legacy_governance_mask.js'
import { maskSensitiveText } from './legacy_0254/legacy_mask_text.js'
import { normalizePiiText } from './legacy_0254/pii_normalize.js'
import type { CustomPiiPattern, GovernancePolicy } from './legacy_0254/types.js'

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'legacy_0254', 'golden.json')
const BUILTIN = ['[MASKED_SECRET]', '[MASKED_PII]']

describe('frozen 0.2.54 corpus', () => {
  it('reads golden.json and matches every frozen output', () => {
    if (!existsSync(GOLDEN)) {
      throw new Error(
        'src/mask/legacy_0254/golden.json is missing. The gate must supply the 0.2.54 corpus; this test does not skip.',
      )
    }
    const rows = readGolden(GOLDEN)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const got = runFrozen(row)
      expect(got).toEqual(row.expected)
    }
  })
})

describe('beltCover', () => {
  it('leaves an unmasked field empty', () => {
    const result = beltCover(textInput('hello'))
    expect(result).toEqual({ ok: true, spans: [], added: 0 })
  })

  it('refuses private-use shields', () => {
    const raw = 'foo\uE0000\uE001 AB12cdef 05321234567'
    const result = beltCover(textInput(raw))
    expect(result).toEqual({ ok: false, reason: 'private-use' })
  })

  it('fails closed on a custom chain that overlaps a token', () => {
    const first = { name: 'ctx', pattern: '\\[\\[MASKED_PII\\] PRIVATEY\\]', label: '[XY]' }
    const nested = beltCover(textInput('[a@b.co PRIVATEY]', [first, { name: 'cut', pattern: 'X', label: '[A]' }]))
    expect(nested).toEqual({ ok: false, reason: 'custom-chain' })
    const context = beltCover(textInput('![a@b.co PRIVATEY]', [first, { name: 'cut', pattern: '!\\[X', label: '[A]' }]))
    expect(context).toEqual({ ok: false, reason: 'custom-chain' })
    const same = beltCover(textInput('[MASKED_PII]', [{ name: 'self', pattern: '\\[MASKED_PII\\]', label: '[MASKED_PII]' }]))
    expect(same).toEqual({ ok: false, reason: 'custom-chain' })
  })

  it('fails closed when a rule only touches a legacy token', () => {
    const result = beltCover(textInput('ID:a@b.co', [{ name: 'id', pattern: 'ID:', label: '[ID]' }]))
    expect(result).toEqual({ ok: false, reason: 'custom-chain' })
  })

  it('stops after a rule with more than 256 matches', () => {
    const raw = 'b'.repeat(257)
    const result = beltCover(textInput(raw, [
      { name: 'wide', pattern: 'a?', label: '[WIDE]' },
      { name: 'bee', pattern: 'W', label: '[NO]' },
    ]))
    expect(result).toEqual({ ok: true, spans: [], wholeField: '[WIDE]', added: 1 })
  })

  it('returns two adjacent custom spans for ab', () => {
    const result = beltCover(textInput('ab', [
      { name: 'a', pattern: 'a', label: '[A]' },
      { name: 'b', pattern: 'b', label: '[B]' },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spans).toHaveLength(2)
    expect(covered(result.spans, 2)).toEqual(new Set([0, 1]))
  })

  it('aligns a title or label glued to the previous token', () => {
    const iban = 'TR330006100519786457841326'
    const titled = `${iban}Dr. Ahmet`
    const labelled = `${iban}name: Ahmet`
    expect(beltCover(govInput(titled))).toEqual({
      ok: true,
      spans: [
        { start: 0, end: iban.length },
        { start: iban.length + 'Dr. '.length, end: titled.length },
      ],
      added: 2,
    })
    expect(beltCover(govInput(labelled))).toEqual({
      ok: true,
      spans: [
        { start: 0, end: iban.length },
        { start: labelled.indexOf(':') + 2, end: labelled.length },
      ],
      added: 2,
    })
    const email = 'a@b.comDr. Ahmet'
    expect(beltCover(govInput(email))).toEqual({
      ok: true,
      spans: [{ start: 0, end: email.length - '. Ahmet'.length }],
      added: 1,
    })
    const between = `${iban}Dr. a@b.com`
    const pair = beltCover(govInput(between))
    expect(pair).toEqual({
      ok: true,
      spans: [
        { start: 0, end: iban.length },
        { start: iban.length + 'Dr. '.length, end: between.length },
      ],
      added: 2,
    })
    if (!pair.ok) return
    const markerAt = between.indexOf('Dr.')
    for (let i = markerAt; i < markerAt + 'Dr.'.length; i++) {
      expect(pair.spans.some((span) => i >= span.start && i < span.end), `Dr. ${i}`).toBe(false)
    }
  })

  it('covers the name and not the label', () => {
    const cases = ['Dr.\tAhmet', 'name:Ahmet', 'name :Ahmet', 'full name:Ahmet']
    for (const raw of cases) {
      const result = beltCover(govInput(raw))
      expect(result.ok, raw).toBe(true)
      if (!result.ok) continue
      const nameAt = raw.lastIndexOf('Ahmet')
      for (let i = 0; i < nameAt; i++) {
        if (/\s/u.test(raw[i])) continue
        expect(result.spans.some((span) => i >= span.start && i < span.end), `${raw} label ${i}`).toBe(false)
      }
      for (let i = nameAt; i < nameAt + 'Ahmet'.length; i++) {
        expect(result.spans.some((span) => i >= span.start && i < span.end), `${raw} name ${i}`).toBe(true)
      }
    }
  })

  it('masks a normal custom id without a chain failure', () => {
    const raw = 'CUST-12345 siparişi'
    const result = beltCover(textInput(raw, [{ name: 'cust', pattern: 'CUST-\\d{5}', label: '[CUST]' }]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (let i = 0; i < 'CUST-12345'.length; i++) {
      expect(result.spans.some((span) => i >= span.start && i < span.end)).toBe(true)
    }
  })

  it('refuses when the work budget is exhausted', () => {
    const raw = 'user@example.com '.repeat(40)
    const result = beltCover({ ...textInput(raw), budget: 1 })
    expect(result).toEqual({ ok: false, reason: 'budget' })
  })

  it('refuses when a dependency throws', () => {
    const policy = new Proxy({}, {
      get() {
        throw new Error('boom')
      },
    }) as GovernancePolicy
    const result = beltCover({
      raw: 'hello',
      normalized: 'hello',
      pipeline: 'governance',
      policy,
      customPatterns: [],
      column: 'note',
    })
    expect(result).toEqual({ ok: false, reason: 'exception' })
  })

  it('returns the legacy token for a raw length cap and a column name', () => {
    const capped = beltCover({ ...textInput('hello hello'), scanCharCap: 4 })
    expect(capped).toEqual({ ok: true, spans: [], wholeField: '[MASKED_PII]', added: 1 })
    const named = beltCover({ ...govInput('ahmet@firma.com'), column: 'public.email' })
    expect(named).toEqual({ ok: true, spans: [], wholeField: '[MASKED_PII]', added: 1 })
  })
})

describe('brute-force alignment', () => {
  const samples = shortSamples()

  it('covers every brute-force wildcard on short plan rows and 200 seeds', () => {
    const seeds = randomSeeds(200)
    const rows = [...samples, ...seeds]
    expect(seeds.length).toBe(200)
    for (const row of rows) {
      if ([...row.raw].length > 40) continue
      const result = beltCover(row.input)
      const tokens = vocab(row.rules)
      const brute = bruteJokers(row.input.normalized, legacyOutput(row.input), tokens)
      if (brute.count === 0n) {
        expect(result.ok, row.raw).toBe(false)
        continue
      }
      if (!result.ok) {
        expect(result.reason, row.raw).not.toBe('unaligned')
        continue
      }
      const mask = result.wholeField
        ? fullSet(row.input.normalized.length)
        : covered(result.spans, row.input.normalized.length)
      for (const index of brute.jokers) {
        // 0.2.54 rewrites the space between a label and a name as its own
        // canonical space. The belt leaves source spaces at a span's edge out:
        // a space is not a value. Every other character must be covered.
        if (/\s/.test(row.input.normalized[index])) continue
        expect(mask.has(index), `${row.raw} @${index}`).toBe(true)
      }
    }
  })

  it('covers every brute-force wildcard on the trimmed path', () => {
    const seeds = randomSeeds(200)
    const rows = [...samples, ...seeds]
    expect(seeds.length).toBe(200)
    for (const row of rows) {
      if ([...row.raw].length > 40) continue
      const source = row.input.normalized
      const output = legacyOutput(row.input)
      const tokens = vocab(row.rules)
      const trimmed = alignRegions(source, output, tokens, 'trim')
      const brute = bruteJokers(source, output, tokens)
      if (brute.count === 0n) {
        expect(trimmed.ok, row.raw).toBe(false)
        continue
      }
      if (!trimmed.ok) {
        expect(trimmed.reason, row.raw).not.toBe('unaligned')
        continue
      }
      const mask = covered(trimmed.spans, source.length)
      for (const index of brute.jokers) {
        expect(mask.has(index), `${row.raw} @${index}`).toBe(true)
      }
    }
  })

  it('matches untrimmed spans on 500 inputs', () => {
    const rows = trimEqualityInputs()
    expect(rows).toHaveLength(500)
    for (const row of rows) {
      const source = row.input.normalized
      const output = legacyOutput(row.input)
      const tokens = vocab(row.rules)
      const plain = alignRegions(source, output, tokens, 'plain')
      const trimmed = alignRegions(source, output, tokens, 'trim')
      expect(trimmed, row.raw).toEqual(plain)
    }
  })

  it('does not align a million characters the old line left unchanged', { timeout: 60_000 }, () => {
    resetAlignCalls()
    const raw = 'm'.repeat(1_000_000)
    const result = beltCover({ ...textInput(raw), scanCharCap: 1_048_576 })
    expect(result).toEqual({ ok: true, spans: [], added: 0 })
    expect(alignCallCount()).toBe(0)
  })

  it('covers a 200k letter run within two seconds', { timeout: 60_000 }, () => {
    const plain = 'm'.repeat(200_000)
    const withScheme = `${plain} x://y`
    const plainStarted = Date.now()
    const plainResult = beltCover({ ...textInput(plain), scanCharCap: 1_048_576 })
    const plainMs = Date.now() - plainStarted
    const schemeStarted = Date.now()
    const schemeResult = beltCover({ ...textInput(withScheme), scanCharCap: 1_048_576 })
    const schemeMs = Date.now() - schemeStarted
    expect(plainMs).toBeLessThan(2_000)
    expect(schemeMs).toBeLessThan(2_000)
    expect(plainResult).toEqual({ ok: true, spans: [], added: 0 })
    expect(schemeResult.ok).toBe(true)
  })
})

function textInput(raw: string, rules: CustomPiiPattern[] = []): BeltInput {
  return {
    raw,
    normalized: normalizePiiText(raw),
    pipeline: 'text',
    customPatterns: compileCustomPatterns(rules),
  }
}

function govInput(raw: string, rules: CustomPiiPattern[] = [], policy: GovernancePolicy = {}): BeltInput {
  return {
    raw,
    normalized: normalizePiiText(raw),
    pipeline: 'governance',
    policy,
    customPatterns: compileCustomPatterns(rules),
  }
}

function vocab(rules: CompiledCustomPattern[]): string[] {
  return [...new Set([...BUILTIN, ...rules.map((rule) => rule.label)])].sort((a, b) => b.length - a.length)
}

function legacyOutput(input: BeltInput): string {
  const plain = input.pipeline === 'text'
    ? maskSensitiveText(input.raw, {
      scanCharCap: input.scanCharCap,
      detectors: input.policy?.detectors,
      customPatterns: [],
    })
    : legacyMaskPiiString(input.raw, {
      policy: { ...(input.policy ?? {}), scanCharCap: input.scanCharCap ?? input.policy?.scanCharCap },
      customPatterns: [],
      column: input.column,
    }).masked
  if (input.customPatterns.length === 0) return plain
  return applyCustomPatterns(plain, input.customPatterns, input.column).text
}

function covered(spans: BeltSpan[], length: number): Set<number> {
  const set = new Set<number>()
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < length; i++) set.add(i)
  }
  return set
}

function fullSet(length: number): Set<number> {
  return new Set(Array.from({ length }, (_, i) => i))
}

interface Sample {
  raw: string
  rules: CompiledCustomPattern[]
  input: BeltInput
}

function shortSamples(): Sample[] {
  const rows: Array<{ raw: string; rules?: CustomPiiPattern[]; pipeline?: 'text' | 'governance' }> = [
    { raw: 'TR330006100519786457841326Dr. Ahmet', pipeline: 'governance' },
    { raw: 'TR330006100519786457841326name: Ahmet', pipeline: 'governance' },
    { raw: 'a@b.comDr. Ahmet', pipeline: 'governance' },
    { raw: 'TR330006100519786457841326Dr. a@b.com', pipeline: 'governance' },
    { raw: '1234567890 555 123 4567' },
    { raw: '12345678901 555 123 4567' },
    { raw: 'a@b.com PRIVATE', rules: [{ name: 'tail', pattern: '\\[MASKED_PII\\] PRIVATE', label: '[PRIV]' }] },
    { raw: 'Dr.\tAhmet', pipeline: 'governance' },
    { raw: 'name : Ahmet', pipeline: 'governance' },
    { raw: 'ABC10000000146', rules: [{ name: 'id', pattern: '10000000146', label: '[MASKED_SECRET]' }] },
    { raw: 'token: password:abcd', pipeline: 'governance' },
    { raw: 'ab', rules: [{ name: 'a', pattern: 'a', label: '[A]' }, { name: 'b', pattern: 'b', label: '[B]' }] },
    { raw: 'pwd: 4111 1111 1111 1112' },
    { raw: 'name:Ahmet', pipeline: 'governance' },
    { raw: 'name :Ahmet', pipeline: 'governance' },
    { raw: 'full name:Ahmet', pipeline: 'governance' },
    { raw: 'pwd: Q7r9 t2Vk z8Hp' },
    { raw: '０５３２１２３４５６７' },
    { raw: 'PRIVATE a PRIVATE a PRIVATE a PRIVATE', rules: [{ name: 'pair', pattern: 'PRIVATE a PRIVATE', label: '[X]' }] },
    { raw: 'CUST-12345 siparişi', rules: [{ name: 'cust', pattern: 'CUST-\\d{5}', label: '[CUST]' }] },
    { raw: 'hello' },
  ]
  return rows.map((row) => {
    const rules = compileCustomPatterns(row.rules ?? [])
    const input = row.pipeline === 'governance' ? govInput(row.raw, row.rules ?? []) : textInput(row.raw, row.rules ?? [])
    return { raw: row.raw, rules, input }
  })
}

function trimEqualityInputs(): Sample[] {
  const specs: Array<{ raw: string; rules?: CustomPiiPattern[]; pipeline?: 'text' | 'governance' }> = []
  const pads = ['', 'k ', 'not ', 'ref ', 'id:', 'xx ', 'son ', 'a ']
  const bodies: Array<[string, 'text' | 'governance']> = [
    ['a@b.co', 'text'],
    ['05321234567', 'text'],
    ['name:Ahmet', 'governance'],
    ['name :Ahmet', 'governance'],
    ['name: Ahmet', 'governance'],
    ['name:  Ahmet', 'governance'],
    ['full name:Ahmet', 'governance'],
    ['adı soyadı:Ahmet', 'governance'],
    ['Dr. Ahmet', 'governance'],
    ['Dr.\tAhmet', 'governance'],
    ['Sayın Ayşe Yılmaz', 'governance'],
    ['TR330006100519786457841326Dr. Ahmet', 'governance'],
  ]
  for (const pad of pads) {
    for (const [body, pipeline] of bodies) {
      specs.push({ raw: pad + body, pipeline })
      specs.push({ raw: `${pad}${body} bitti`, pipeline })
      specs.push({ raw: `${pad}${body}]`, pipeline })
    }
  }
  for (let i = 0; i < 60; i++) {
    specs.push({
      raw: `p${i}ABC]`,
      rules: [{ name: 'cut', pattern: 'ABC\\]', label: '[MASKED]' }],
    })
    specs.push({
      raw: `[ABC${i}x`,
      rules: [{ name: 'cut', pattern: '\\[ABC', label: '[ABC]' }],
    })
  }
  const rand = mulberry32(500)
  const alphabet = 'abcxyz .,:'
  while (specs.length < 500) {
    const n = specs.length
    let raw = ''
    const length = 8 + (n % 24)
    for (let i = 0; i < length; i++) raw += alphabet[Math.floor(rand() * alphabet.length)]
    if (n % 2 === 0) raw = `${raw.slice(0, 4)}a@b.co${raw.slice(4)}`
    if (n % 5 === 0) raw = `on ${raw} name:Ahmet`
    specs.push({ raw, pipeline: n % 5 === 0 ? 'governance' : 'text' })
  }
  return specs.slice(0, 500).map((row) => {
    const rules = compileCustomPatterns(row.rules ?? [])
    const input = row.pipeline === 'governance' ? govInput(row.raw, row.rules ?? []) : textInput(row.raw, row.rules ?? [])
    return { raw: row.raw, rules, input }
  })
}

function randomSeeds(count: number): Sample[] {
  const alphabet = 'abcxyz .,:'
  const out: Sample[] = []
  for (let seed = 1; seed <= count; seed++) {
    const rand = mulberry32(seed)
    const length = 1 + Math.floor(rand() * 40)
    let raw = ''
    for (let i = 0; i < length; i++) raw += alphabet[Math.floor(rand() * alphabet.length)]
    if (seed % 17 === 0 && raw.length >= 12) raw = `${raw.slice(0, 6)}a@b.co${raw.slice(12)}`
    if (seed % 29 === 0 && raw.length >= 16) raw = `${raw.slice(0, 4)}05321234567${raw.slice(15)}`
    out.push({ raw, rules: [], input: textInput(raw.slice(0, 40)) })
  }
  return out
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LABELS = ['adı soyadı', 'adi soyadi', 'ad soyad', 'full name', 'müşteri', 'musteri', 'yetkili', 'temsilci', 'customer', 'contact', 'kişi', 'kisi', 'name']
const TITLES = ['Sayın', 'Sayin', 'Bayan', 'Mrs.', 'Mr.', 'Ms.', 'Prof.', 'Dr.', 'Av.', 'Bay', 'Sn.']

function bruteJokers(source: string, output: string, tokens: string[]): { count: bigint; jokers: Set<number> } {
  const pieces = brutePieces(output, tokens)
  const n = source.length
  const ways: bigint[][] = Array.from({ length: pieces.length + 1 }, () => Array<bigint>(n + 1).fill(0n))
  ways[0][0] = 1n
  for (let i = 0; i < pieces.length; i++) {
    for (let pos = 0; pos <= n; pos++) {
      if (ways[i][pos] === 0n) continue
      for (const end of pieceEnds(source, pos, pieces[i])) {
        if (end >= pos && end <= n) ways[i + 1][end] += ways[i][pos]
      }
    }
  }
  const back: bigint[][] = Array.from({ length: pieces.length + 1 }, () => Array<bigint>(n + 1).fill(0n))
  back[pieces.length][n] = 1n
  for (let i = pieces.length - 1; i >= 0; i--) {
    for (let pos = 0; pos <= n; pos++) {
      if (ways[i][pos] === 0n) continue
      for (const end of pieceEnds(source, pos, pieces[i])) {
        if (end >= pos && end <= n) back[i][pos] += back[i + 1][end]
      }
    }
  }
  const jokers = new Set<number>()
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind !== 'tok') continue
    for (let pos = 0; pos <= n; pos++) {
      if (ways[i][pos] === 0n) continue
      for (const end of pieceEnds(source, pos, pieces[i])) {
        if (back[i + 1][end] === 0n) continue
        for (let j = pos; j < end; j++) jokers.add(j)
      }
    }
  }
  return { count: ways[pieces.length][n], jokers }
}

type BrutePiece =
  | { kind: 'lit'; text: string; mode: 'exact' | 'label' | 'title' }
  | { kind: 'tok'; text: string }

function brutePieces(output: string, tokens: string[]): BrutePiece[] {
  const sorted = [...tokens].sort((a, b) => b.length - a.length)
  const raw: Array<{ kind: 'lit'; text: string } | { kind: 'tok'; text: string }> = []
  let i = 0
  while (i < output.length) {
    const tok = sorted.find((token) => token.length > 0 && output.startsWith(token, i))
    if (tok) {
      raw.push({ kind: 'tok', text: tok })
      i += tok.length
    } else {
      const prev = raw[raw.length - 1]
      if (prev && prev.kind === 'lit') prev.text += output[i]
      else raw.push({ kind: 'lit', text: output[i] })
      i++
    }
  }
  if (raw.length === 0 || raw[0].kind === 'tok') raw.unshift({ kind: 'lit', text: '' })
  if (raw[raw.length - 1].kind === 'tok') raw.push({ kind: 'lit', text: '' })
  const spaced: typeof raw = []
  for (const piece of raw) {
    if (piece.kind === 'tok' && spaced.length > 0 && spaced[spaced.length - 1].kind === 'tok') {
      spaced.push({ kind: 'lit', text: '' })
    }
    spaced.push(piece)
  }
  return spaced.map((piece, index) => {
    if (piece.kind === 'tok') return piece
    const next = spaced[index + 1]
    const nextTok = next && next.kind === 'tok' ? next.text : null
    return { kind: 'lit', text: piece.text, mode: bruteMode(piece.text, nextTok) }
  })
}

function bruteMode(text: string, nextTok: string | null): 'exact' | 'label' | 'title' {
  if (nextTok !== '[MASKED_PII]') return 'exact'
  if (text.endsWith(': ') && labelHead(text.slice(0, -2))) return 'label'
  if (text.endsWith(' ') && !text.endsWith(': ') && titleHead(text.slice(0, -1))) return 'title'
  return 'exact'
}

function labelHead(head: string): boolean {
  const lower = head.toLowerCase()
  return LABELS.some((label) => {
    if (!lower.endsWith(label)) return false
    const at = head.length - label.length
    return at <= 0 || !/[\p{L}\p{N}]/u.test(head[at - 1] ?? '')
  })
}

function titleHead(head: string): boolean {
  return TITLES.some((title) => {
    if (!head.endsWith(title)) return false
    const at = head.length - title.length
    return at <= 0 || !/[\p{L}\p{N}]/u.test(head[at - 1] ?? '')
  })
}

function pieceEnds(source: string, pos: number, piece: BrutePiece): number[] {
  if (piece.kind === 'tok') {
    const ends: number[] = []
    for (let end = pos; end <= source.length; end++) ends.push(end)
    return ends
  }
  if (piece.mode === 'exact') {
    if (piece.text.length === 0) return pos <= source.length ? [pos] : []
    return source.startsWith(piece.text, pos) ? [pos + piece.text.length] : []
  }
  if (piece.mode === 'label') return labelEnds(source, pos, piece.text)
  return titleEnds(source, pos, piece.text)
}

function labelEnds(source: string, pos: number, literal: string): number[] {
  const head = literal.slice(0, -2)
  if (!source.startsWith(head, pos)) return []
  let cursor = pos + head.length
  while (cursor < source.length && /\s/u.test(source[cursor])) cursor++
  if (source[cursor] !== ':') return []
  const after = cursor + 1
  let endMax = after
  while (endMax < source.length && /\s/u.test(source[endMax])) endMax++
  const ends: number[] = []
  for (let end = after; end <= endMax; end++) ends.push(end)
  return ends
}

function titleEnds(source: string, pos: number, literal: string): number[] {
  const head = literal.slice(0, -1)
  if (!source.startsWith(head, pos)) return []
  const after = pos + head.length
  let endMax = after
  while (endMax < source.length && /\s/u.test(source[endMax])) endMax++
  const ends: number[] = []
  for (let end = after; end <= endMax; end++) ends.push(end)
  return ends
}

function readGolden(path: string): Array<{ expected: unknown; input: string; pipeline: 'text' | 'governance'; options: Record<string, unknown> }> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
    ? (parsed as { cases: unknown[] }).cases
    : null
  if (!list) {
    throw new Error('golden.json must be an array, or an object with a cases array')
  }
  return list.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`golden.json row ${index} is not an object`)
    const rec = row as Record<string, unknown>
    const input = firstString(rec, ['input', 'raw', 'text'])
    if (input === undefined) throw new Error(`golden.json row ${index} has no input`)
    const expected = rec.expected ?? rec.output ?? rec.masked
    if (expected === undefined) throw new Error(`golden.json row ${index} has no output`)
    const pipeline = rec.pipeline === 'governance' || rec.kind === 'governance' ? 'governance' : 'text'
    const options = rec.options && typeof rec.options === 'object' ? rec.options as Record<string, unknown> : rec
    return { expected, input, pipeline, options }
  })
}

function firstString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof rec[key] === 'string') return rec[key]
  }
  return undefined
}

function runFrozen(row: { input: string; pipeline: 'text' | 'governance'; options: Record<string, unknown>; expected: unknown }): unknown {
  const options = row.options
  const policy = (options.policy && typeof options.policy === 'object' ? options.policy : {}) as GovernancePolicy
  const patterns = Array.isArray(options.customPatterns)
    ? compileCustomPatterns(options.customPatterns as CustomPiiPattern[])
    : []
  const column = typeof options.column === 'string' ? options.column : undefined
  const scanCharCap = typeof options.scanCharCap === 'number' ? options.scanCharCap : policy.scanCharCap
  const valueType = options.valueType === 'number' || options.valueType === 'bigint' ? options.valueType : 'string'
  if (row.pipeline === 'governance' || valueType !== 'string') {
    const opts = { policy: { ...policy, scanCharCap }, customPatterns: patterns, column }
    if (valueType === 'bigint') return legacyMaskPiiNumber(BigInt(row.input), opts)
    if (valueType === 'number') return legacyMaskPiiNumber(Number(row.input), opts)
    const got = legacyMaskPiiString(row.input, opts)
    return typeof row.expected === 'string' ? got.masked : got
  }
  return maskSensitiveText(row.input, {
    scanCharCap,
    detectors: policy.detectors ?? (options.detectors as GovernancePolicy['detectors']),
    customPatterns: patterns,
  })
}
