import { describe, it, expect } from 'vitest'
import { buildReceipt, nextChainState, RECEIPT_VERSION, type ReceiptInput } from './receipt.js'

process.env.CONARIUM_AUDIT_UNSIGNED = '1'

function sampleInput(): ReceiptInput {
  return {
    period: { start: '2026-07-29T08:00:00.000Z', end: '2026-07-29T08:00:02.000Z' },
    actor: { id: 'conarium_c2' },
    model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
    client: { name: 'cursor', version: '2.x' },
    request: {
      tool: 'query',
      target: 'demo-db',
      argsHash: 'sha256:abc',
    },
    dataRefs: [],
    policy: {
      id: 'conarium.config.c2',
      version: '3',
      decision: 'partial',
      rulesApplied: ['allowlist.table', 'mask.pii', 'rowcap'],
    },
    flags: ['rowcap_hit'],
    masking: {
      maskedCount: 0,
      byClass: {},
      rowsReturned: 0,
      rowCapApplied: false,
    },
    outcome: { status: 'complete', denied: false },
  }
}

describe('makbuz v0.2 aktörü', () => {
  it('sürüm 0.2', () => {
    expect(RECEIPT_VERSION).toBe('conarium-receipt/0.2')
  })

  it('aktör türü verilmezse service kalır ve shared-token beyan edilir', () => {
    const r = buildReceipt(sampleInput(), nextChainState(null), null)
    expect(r.actor.type).toBe('service')
    expect(r.actor.assurance).toBe('shared-token')
  })

  it('kişi token eşleştiyse user + per-user-token yazılır', () => {
    const inp = sampleInput()
    inp.actor = { id: 'ayse@sirket.com', type: 'user', assurance: 'per-user-token' }
    const r = buildReceipt(inp, nextChainState(null), null)
    expect(r.actor).toEqual({ type: 'user', id: 'ayse@sirket.com', assurance: 'per-user-token' })
  })

  it('user + shared-token kombinasyonu REDDEDILIR — kanıtsız kişi iddiası olamaz', () => {
    const inp = sampleInput()
    inp.actor = { id: 'ayse@sirket.com', type: 'user', assurance: 'shared-token' }
    expect(() => buildReceipt(inp, nextChainState(null), null)).toThrow(/shared-token/)
  })
})
