/**
 * destination — beyan, doğrulama değil.
 * Politika kararı bu alana bağlanmaz.
 */
import { describe, expect, it } from 'vitest'
import { buildReceipt, nextChainState, type ReceiptInput } from './receipt.js'

process.env.CONARIUM_AUDIT_UNSIGNED = '1'

function temel(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    period: { start: '2026-08-16T12:00:00.000Z', end: '2026-08-16T12:00:01.000Z' },
    actor: { id: 'conarium_c2' },
    request: { tool: 'query', target: 'demo-db', argsHash: 'sha256:abc' },
    dataRefs: [],
    policy: { id: 'p', version: '1', decision: 'allow', rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
    ...overrides,
  }
}

describe('buildReceipt destination', () => {
  it('beyan yoksa undeclared — value null, uydurma yok', () => {
    const r = buildReceipt(temel(), nextChainState(null), null)
    expect(r.destination).toEqual({ value: null, source: 'undeclared' })
  })

  it('operatör beyanı operator-declared olarak taşınır — verified yok', () => {
    const r = buildReceipt(temel({ destination: 'openai/gpt-x' }), nextChainState(null), null)
    expect(r.destination).toEqual({ value: 'openai/gpt-x', source: 'operator-declared' })
    expect(JSON.stringify(r)).not.toMatch(/verified/)
    expect(JSON.stringify(r.destination)).not.toMatch(/safe|güvenli/)
  })

  it('boş string undeclared sayılır', () => {
    const r = buildReceipt(temel({ destination: '' }), nextChainState(null), null)
    expect(r.destination.source).toBe('undeclared')
    expect(r.destination.value).toBeNull()
  })

  it('destination politika kararını değiştirmez', () => {
    const allow = buildReceipt(temel({ destination: 'openai/gpt-x' }), nextChainState(null), null)
    const denyIn = temel({
      destination: 'openai/gpt-x',
      policy: { id: 'p', version: '1', decision: 'deny', rulesApplied: [] },
      outcome: { status: 'denied', denied: true },
    })
    const deny = buildReceipt(denyIn, nextChainState(null), null)
    expect(allow.policy.decision).toBe('allow')
    expect(deny.policy.decision).toBe('deny')
    expect(allow.destination).toEqual(deny.destination)
  })
})
