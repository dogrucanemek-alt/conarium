/**
 * Property invariants — random inputs, not hand-picked examples.
 *
 * Each property below runs ≥1000 cases. A bank supplier-security review
 * that only sees example tests has not seen these.
 *
 * Tamper exit-code rule (frozen verifier contract; this file does not invent
 * a new mapping). A single-byte mutation of a valid receipt JSONL never
 * exits 0. Which non-zero code depends on what the byte hit:
 *
 *   20  JSON no longer parses, or a required field is gone / mistyped
 *   10  still JSON, stored chain.hash ≠ recomputed body hash
 *   11  prevHash no longer points at the previous record
 *   12  seq is no longer contiguous / increasing
 *   13  signature, keyId, or pubkey check fails
 *
 * 14/15 only arise with --anchor-check (not in this property).
 * The two most common outcomes of a uniformly random byte flip are 20
 * (broken JSON) and 13 (broken signature). The assertion is the stronger
 * one: never 0, and the code is one of {10,11,12,13,20}.
 *
 * Bytes that only sit in the prefix/suffix the verifier `trim()`s are not
 * a mutation of the chain it reads; those cases are skipped, not counted
 * as a pass.
 *
 * Node's default base64 decoder used to accept URL-safe alphabets, garbled
 * padding, and unused padding bits as the same signature — a one-byte
 * mutation then exited 0. The verifier now requires canonical base64
 * (round-trip `Buffer.from(s,'base64').toString('base64') === s`).
 */
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { Governance } from './governance.js'
import { canonicalize, buildReceipt, nextChainState, hashArgs, type ReceiptInput } from './receipt.js'
import { loadSigningKey, writeKeyPairFiles } from './keys.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY = join(HERE, '..', 'bin', 'conarium-verify.mjs')

const RUNS = 1000
const SEED_EMAIL = 'seed-mask-invariant@conarium.test'
const SEED_CARD = '4111111111111111'
const SEED_NAME = 'Zeynep-Mask-Seed-9f3a'
const SEEDS = [SEED_EMAIL, SEED_CARD, SEED_NAME] as const

const fcAssert = (prop: fc.IAsyncProperty<unknown[]> | fc.IProperty<unknown[]>, extra: fc.Parameters<unknown[]> = {}) =>
  fc.assert(prop, { numRuns: RUNS, ...extra })

function walkStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    acc.push(value)
    return acc
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    acc.push(String(value))
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, acc)
    return acc
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k)
      walkStrings(v, acc)
    }
  }
  return acc
}

function containsSeed(value: unknown): string | null {
  const parts = walkStrings(value)
  for (const part of parts) {
    for (const seed of SEEDS) {
      if (part.includes(seed)) return seed
    }
  }
  return null
}

function shuffleKeys(value: unknown, pick: () => number): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, pick))
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(pick() * (i + 1))
      const tmp = entries[i]
      entries[i] = entries[j]
      entries[j] = tmp
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of entries) out[k] = shuffleKeys(v, pick)
    return out
  }
  return value
}

function jcsHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

const COLS = ['id', 'email', 'card', 'note', 'name'] as const

const allowedQueryArb = fc.record({
  cols: fc.uniqueArray(fc.constantFrom(...COLS), { minLength: 1, maxLength: COLS.length }),
  star: fc.boolean(),
  alias: fc.boolean(),
  limit: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
  offset: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
}).map(({ cols, star, alias, limit, offset }) => {
  const from = alias ? 'public.customers c' : 'public.customers'
  const projection = star
    ? (alias ? 'c.*' : '*')
    : cols.map((c) => (alias ? `c.${c}` : c)).join(', ')
  let sql = `SELECT ${projection} FROM ${from}`
  if (limit !== null) sql += ` LIMIT ${limit}`
  if (offset !== null) sql += ` OFFSET ${offset}`
  return { sql, limit, offset }
})

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  email: fc.constant(SEED_EMAIL),
  card: fc.constant(SEED_CARD),
  name: fc.constant(SEED_NAME),
  note: fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.constant(SEED_EMAIL),
    fc.constant(SEED_NAME),
    fc.constant('no-pii'),
  ),
})

function sampleInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    period: { start: '2026-08-15T00:00:00.000Z', end: '2026-08-15T00:00:01.000Z' },
    actor: { id: 'conarium_invariant' },
    model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
    client: { name: 'cursor', version: '2.x' },
    request: { tool: 'query', target: 'demo-db', argsHash: hashArgs({ sql: 'select 1' }) },
    dataRefs: [{ source: 'zion', object: 'v_monthly', fieldsRequested: ['month', 'revenue'] }],
    policy: {
      id: 'conarium.config.c2',
      version: '3',
      decision: 'partial',
      rulesApplied: ['allowlist.table', 'mask.pii'],
    },
    flags: [],
    masking: {
      maskedCount: 0,
      byClass: { email: 0, phone: 0, tckn: 0, secret: 0 },
      rowsReturned: 1,
      rowCapApplied: false,
    },
    outcome: { status: 'complete', denied: false },
    ...overrides,
  }
}

function runVerify(args: string[]): number {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return res.status ?? 1
}

const jsonLeaf = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).filter((n) => Number.isFinite(n)),
  fc.string({ unit: 'grapheme', minLength: 0, maxLength: 24 }),
  fc.constantFrom('ıİşŞğĞüÜöÖçÇ', '日本語', '🙂', 'Ω', '\u0000', 'a\nb', 'quote"slash\\'),
)

const jsonValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    jsonLeaf,
    fc.array(tie('value'), { maxLength: 5 }),
    fc.dictionary(
      fc.oneof(fc.string({ minLength: 1, maxLength: 16 }), fc.constantFrom('z', 'a', 'ü', '🙂', '1')),
      tie('value'),
      { maxKeys: 6 },
    ),
  ),
})).value

describe('M1 property invariants', () => {
  it('mask: policy seed values never appear plaintext in governed output', () => {
    const gov = new Governance({
      allowTables: ['public.customers'],
      maskColumns: ['*.email', '*.card', '*.name'],
      maxRows: 25,
    })
    fcAssert(
      fc.property(allowedQueryArb, fc.array(rowArb, { minLength: 1, maxLength: 20 }), (q, rows) => {
        const guarded = gov.guardQuery(q.sql)
        expect(guarded.metadata.denied).toBe(false)
        const redacted = gov.redact(
          { rows, rowCount: rows.length, fields: Object.keys(rows[0] ?? {}) },
          guarded.aliases,
          guarded.metadata,
        )
        const leaked = containsSeed(redacted.rows)
        expect(leaked).toBeNull()
      }),
    )
  })

  it('row cap: LIMIT/OFFSET combinations never return more than maxRows', () => {
    fcAssert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        allowedQueryArb,
        fc.integer({ min: 0, max: 5_000 }),
        (maxRows, q, rawCount) => {
          const gov = new Governance({
            allowTables: ['public.customers'],
            maskColumns: ['*.email'],
            maxRows,
          })
          const guarded = gov.guardQuery(q.sql)
          expect(guarded.metadata.denied).toBe(false)
          const limitMatch = guarded.sql.match(/\bLIMIT\s+\(?(\d+)\)?/i)
          expect(limitMatch).not.toBeNull()
          const sqlLimit = Number(limitMatch![1])
          expect(sqlLimit).toBeLessThanOrEqual(maxRows)
          if (q.limit !== null && q.limit <= maxRows) {
            expect(sqlLimit).toBe(q.limit)
          }
          const returned = Math.min(rawCount, sqlLimit)
          expect(returned).toBeLessThanOrEqual(maxRows)
        },
      ),
    )
  })

  it('JCS: shuffled key order yields the same canonicalize and hash', () => {
    fcAssert(
      fc.property(jsonValue, fc.nat(), (value, seed) => {
        let s = seed >>> 0
        const pick = () => {
          s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0)
          return (s >>> 0) / 0x100000000
        }
        const shuffled = shuffleKeys(value, pick)
        expect(canonicalize(shuffled)).toBe(canonicalize(value))
        expect(jcsHash(shuffled)).toBe(jcsHash(value))
      }),
    )
  })

  it('tamper: a one-byte mutation of a valid chain never exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-inv-'))
    const { privatePath, publicPath } = writeKeyPairFiles(join(dir, 'inv'), 'cnr-inv')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath
    const key = loadSigningKey()
    if (!key) throw new Error('signing key required')

    const receipts = []
    let state = nextChainState(null)
    for (let i = 0; i < 3; i++) {
      const r = buildReceipt(
        sampleInput({ id: `01INV${String(i).padStart(21, '0')}`, ts: `2026-08-15T00:00:0${i}.000Z` }),
        state,
        key,
      )
      receipts.push(r)
      state = nextChainState(r)
    }
    const intact = receipts.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const intactPath = join(dir, 'intact.jsonl')
    writeFileSync(intactPath, intact)
    expect(runVerify([intactPath, '--pubkey', publicPath])).toBe(0)

    const bytes = Buffer.from(intact, 'utf-8')
    expect(bytes.length).toBeGreaterThan(8)
    const mutPath = join(dir, 'mutated.jsonl')

    fcAssert(
      fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (index, delta) => {
        const mutated = Buffer.from(bytes)
        mutated[index] = (mutated[index] + delta) & 0xff
        if (mutated.equals(bytes)) return
        // The verifier trims the file. A byte that only lives in that
        // stripped prefix/suffix is not a mutation of the chain it reads.
        if (mutated.toString('utf8').trim() === intact.trim()) return
        writeFileSync(mutPath, mutated)
        const code = runVerify([mutPath, '--pubkey', publicPath])
        expect([10, 11, 12, 13, 20]).toContain(code)
        expect(code).not.toBe(0)
      }),
      { numRuns: RUNS, timeout: 180_000 },
    )

    rmSync(dir, { recursive: true, force: true })
  }, 180_000)
})
