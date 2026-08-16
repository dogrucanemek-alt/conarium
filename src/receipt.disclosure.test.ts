/**
 * Makbuz disclosure — sınırdan geçen baytların taahhüdü.
 *
 * Hash, istemciye giden maskelenmiş / satır-tavanı uygulanmış metnin UTF-8
 * baytları üzerindendir. Aynı metin → aynı hash (süreçler arası). Ret/hata
 * yolunda alan undeclared'dır; uydurma yok.
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  buildReceipt,
  hashDisclosure,
  nextChainState,
  type ReceiptInput,
} from './receipt.js'

process.env.CONARIUM_AUDIT_UNSIGNED = '1'

function temel(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    period: { start: '2026-08-16T12:00:00.000Z', end: '2026-08-16T12:00:01.000Z' },
    actor: { id: 'conarium_c2' },
    request: { tool: 'query', target: 'demo-db', argsHash: 'sha256:abc' },
    dataRefs: [],
    policy: { id: 'p', version: '1', decision: 'allow', rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 1, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
    ...overrides,
  }
}

describe('hashDisclosure', () => {
  it('aynı metin → aynı hash ve bayt sayısı, süreçten bağımsız', () => {
    const payload = JSON.stringify({ rowCount: 1, rows: [{ id: 1 }], truncated: false }, null, 2)
    const a = hashDisclosure(payload)
    const b = hashDisclosure(payload)
    expect(a).toEqual(b)
    expect(a.hash).toBe(`sha256:${createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex')}`)
    expect(a.bytes).toBe(Buffer.byteLength(payload, 'utf8'))
  })

  it('farklı metin → farklı hash', () => {
    expect(hashDisclosure('yes').hash).not.toBe(hashDisclosure('no').hash)
  })
})

describe('buildReceipt disclosure', () => {
  it('payload yoksa undeclared — hash/bytes uydurulmaz', () => {
    const r = buildReceipt(temel(), nextChainState(null), null)
    expect(r.disclosure).toEqual({ hash: null, bytes: null, source: 'undeclared' })
  })

  it('başarılı yolda measured: hash payload UTF-8 baytlarıdır', () => {
    const payload = '{"rowCount":1,"rows":[{"ok":true}],"truncated":false}'
    const r = buildReceipt(temel({ disclosurePayload: payload }), nextChainState(null), null)
    expect(r.disclosure.source).toBe('measured')
    expect(r.disclosure).toEqual({ ...hashDisclosure(payload), source: 'measured' })
    expect(JSON.stringify(r)).not.toContain(payload)
  })

  it('ret yolunda payload verilse bile undeclared — uydurma yok', () => {
    const r = buildReceipt(
      temel({
        disclosurePayload: '{"secret":true}',
        outcome: { status: 'denied', denied: true },
        policy: { id: 'p', version: '1', decision: 'deny', rulesApplied: [] },
      }),
      nextChainState(null),
      null,
    )
    expect(r.disclosure).toEqual({ hash: null, bytes: null, source: 'undeclared' })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('error durumunda undeclared', () => {
    const r = buildReceipt(
      temel({
        disclosurePayload: 'oops',
        outcome: { status: 'error', denied: false },
      }),
      nextChainState(null),
      null,
    )
    expect(r.disclosure.source).toBe('undeclared')
    expect(r.disclosure.hash).toBeNull()
  })

  it('disclosure imzanın içinde: sonradan değiştirmek hash kırar', async () => {
    const { receiptHash } = await import('./receipt.js')
    const r = buildReceipt(temel({ disclosurePayload: 'rows' }), nextChainState(null), null)
    const kurcalanmis = JSON.parse(JSON.stringify(r))
    kurcalanmis.disclosure.source = 'undeclared'
    kurcalanmis.disclosure.hash = null
    kurcalanmis.disclosure.bytes = null
    const { chain, sig, anchor, ...govde } = kurcalanmis
    const { hash, ...chainsiz } = chain
    expect(receiptHash({ ...govde, chain: chainsiz })).not.toBe(r.chain.hash)
  })
})
