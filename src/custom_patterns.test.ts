/**
 * Operator-defined PII patterns — compile fail-closed, same scanner, receipt name.
 */
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { parseConariumConfig } from './config.js'
import {
  compileCustomPatterns,
  CustomPatternError,
  looksUnsafe,
} from './custom_patterns.js'
import { Governance } from './governance.js'
import { writeKeyPairFiles } from './keys.js'
import type { Receipt } from './receipt.js'

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

const TEB_HESAP = {
  name: 'teb-hesap',
  pattern: 'HSP-[0-9]{8}',
  columns: ['*.hesap_no'],
  label: '[MASKED_HESAP]',
}

describe('customPatterns — compile fail-closed', () => {
  it('accepts a bounded bank-style rule and keeps the name', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: { customPatterns: [TEB_HESAP] },
    })
    expect(cfg.policy?.customPatterns?.[0]?.name).toBe('teb-hesap')
    expect(() => compileCustomPatterns([TEB_HESAP])).not.toThrow()
  })

  it('accepts an optional sample and still rejects unknown keys', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: { customPatterns: [{ ...TEB_HESAP, sample: 'HSP-12345678' }] },
    })
    expect(cfg.policy?.customPatterns?.[0]?.sample).toBe('HSP-12345678')
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { customPatterns: [{ ...TEB_HESAP, probe: 'no' }] },
      }),
    ).toThrow(/Unrecognized key/)
  })

  it('broken regex rejects the config and names the rule — not the pattern', () => {
    const started = Date.now()
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { customPatterns: [{ name: 'bozuk-kural', pattern: '(unclosed' }] },
      }),
    ).toThrow(CustomPatternError)
    try {
      parseConariumConfig({
        ...BASE,
        policy: { customPatterns: [{ name: 'bozuk-kural', pattern: '(unclosed' }] },
      })
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('bozuk-kural')
      expect(msg).not.toContain('unclosed')
      expect(msg).not.toContain('(')
    }
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('ReDoS-shaped pattern is rejected at compile — process does not hang', () => {
    const evil = '(a+)+$'
    expect(looksUnsafe(evil)).toBe(true)
    const started = Date.now()
    expect(() => compileCustomPatterns([{ name: 'redos-aday', pattern: evil }])).toThrow(
      /unbounded or nested/,
    )
    expect(Date.now() - started).toBeLessThan(50)
    try {
      compileCustomPatterns([{ name: 'redos-aday', pattern: evil }])
    } catch (err) {
      expect((err as Error).message).not.toContain(evil)
      expect((err as Error).message).toContain('redos-aday')
    }
  })

  it('unbounded + / * and open {n,} are rejected', () => {
    for (const pattern of ['[0-9]+', 'a*', 'x{3,}', '(ab)+']) {
      expect(looksUnsafe(pattern), pattern).toBe(true)
      expect(() => compileCustomPatterns([{ name: 'genis', pattern }])).toThrow(CustomPatternError)
    }
  })

  it('duplicate names (case-insensitive) are rejected', () => {
    expect(() =>
      compileCustomPatterns([
        { name: 'teb-hesap', pattern: 'HSP-[0-9]{8}' },
        { name: 'TEB-hesap', pattern: 'HSP-[0-9]{6}' },
      ]),
    ).toThrow(/duplicated/)
  })

  it('Governance constructor fails closed on a bad rule — silent drop is a leak', () => {
    expect(
      () =>
        new Governance({
          customPatterns: [{ name: 'sessiz-olmasin', pattern: '(a+)+' }],
        }),
    ).toThrow(/sessiz-olmasin/)
  })
})

describe('customPatterns — same scanner as built-ins', () => {
  const gov = new Governance({
    allowTables: ['public.notes'],
    maskColumns: [],
    customPatterns: [TEB_HESAP],
  })

  it('matches, masks with the label, and records the rule name', () => {
    const r = gov.maskPII('ref HSP-12345678 bitti', { column: 'public.notes.hesap_no' })
    expect(r.masked).toBe('ref [MASKED_HESAP] bitti')
    expect(r.count).toBe(1)
    expect(r.byClass).toEqual({ 'teb-hesap': 1 })
    expect(JSON.stringify(r)).not.toContain('HSP-[0-9]')
  })

  it('column-scoped rule does not fire on another field', () => {
    const r = gov.maskPII('ref HSP-12345678 bitti', { column: 'public.notes.aciklama' })
    expect(r.masked).toBe('ref HSP-12345678 bitti')
    expect(r.count).toBe(0)
    expect(r.byClass).toEqual({})
  })

  it('redact puts the rule name on governance.byClass', () => {
    const result = gov.redact({
      rows: [
        { _table: 'public.notes', hesap_no: 'HSP-12345678', aciklama: 'HSP-12345678' },
      ],
      rowCount: 1,
      fields: ['hesap_no', 'aciklama'],
    })
    expect(result.rows[0].hesap_no).toBe('[MASKED_HESAP]')
    expect(result.rows[0].aciklama).toBe('HSP-12345678')
    expect(result.governance.byClass).toEqual({ 'teb-hesap': 1 })
    expect(JSON.stringify(result.governance)).not.toContain('HSP-[0-9]')
  })

  it('unscoped rule applies to every scanned field', () => {
    const g = new Governance({
      customPatterns: [{ name: 'musteri-no', pattern: 'M[0-9]{6}', label: '[MASKED_MUSTERI]' }],
    })
    const r = g.maskPII('musteri M123456 not')
    expect(r.masked).toBe('musteri [MASKED_MUSTERI] not')
    expect(r.byClass).toEqual({ 'musteri-no': 1 })
  })

  it('built-in TCKN / email still fire when customPatterns are present', () => {
    const r = gov.maskPII('tckn 10000000146 mail patron@sirket.com')
    expect(String(r.masked)).toContain('[MASKED_PII]')
    expect(r.count).toBeGreaterThan(0)
  })
})

describe('customPatterns — receipt shows the name, not the pattern', () => {
  const ENV_SIGNING = 'CONARIUM_AUDIT_SIGNING_KEY'
  const ENV_KEY_ID = 'CONARIUM_AUDIT_KEY_ID'
  const ENV_HMAC = 'CONARIUM_AUDIT_HMAC_KEY'
  const ENV_UNSIGNED = 'CONARIUM_AUDIT_UNSIGNED'
  const prev = {
    signing: process.env[ENV_SIGNING],
    keyId: process.env[ENV_KEY_ID],
    hmac: process.env[ENV_HMAC],
    unsigned: process.env[ENV_UNSIGNED],
  }
  let keyDir: string

  beforeAll(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'conarium-custom-receipt-'))
    const files = writeKeyPairFiles(join(keyDir, 'audit-ed25519'), 'test-custom-key')
    process.env[ENV_SIGNING] = files.privatePath
    process.env[ENV_KEY_ID] = 'test-custom-key'
    delete process.env[ENV_HMAC]
    delete process.env[ENV_UNSIGNED]
  })

  afterAll(() => {
    if (prev.signing === undefined) delete process.env[ENV_SIGNING]
    else process.env[ENV_SIGNING] = prev.signing
    if (prev.keyId === undefined) delete process.env[ENV_KEY_ID]
    else process.env[ENV_KEY_ID] = prev.keyId
    if (prev.hmac === undefined) delete process.env[ENV_HMAC]
    else process.env[ENV_HMAC] = prev.hmac
    if (prev.unsigned === undefined) delete process.env[ENV_UNSIGNED]
    else process.env[ENV_UNSIGNED] = prev.unsigned
  })

  it('masking.byClass carries the rule name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-custom-sink-'))
    const receiptSink = join(dir, 'receipts.jsonl')
    const gov = new Governance({ customPatterns: [TEB_HESAP] })
    const redacted = gov.redact({
      rows: [{ _table: 'public.notes', hesap_no: 'HSP-87654321' }],
      rowCount: 1,
      fields: ['hesap_no'],
    })
    const audit = new Audit({
      sink: join(dir, 'audit.jsonl'),
      receiptSink,
      receiptMeta: {
        model: { provider: 'test', name: 't', version: '1' },
        client: { name: 't', version: '1' },
      },
      customPatterns: [TEB_HESAP],
    })
    audit.log({
      tool: 'query',
      target: 'public.notes',
      denied: false,
      maskedCount: redacted.governance.maskedCount,
      rowsReturned: 1,
      governance: redacted.governance,
    })
    const receipts = existsSync(receiptSink)
      ? readFileSync(receiptSink, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Receipt)
      : []
    expect(receipts).toHaveLength(1)
    expect(receipts[0].masking.byClass).toEqual({ 'teb-hesap': 1 })
    const dumped = JSON.stringify(receipts[0])
    expect(dumped).toContain('teb-hesap')
    expect(dumped).not.toContain('HSP-[0-9]')
    expect(dumped).not.toContain('87654321')
  })
})
