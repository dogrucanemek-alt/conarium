import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildReceipt, RECEIPT_GENESIS_HASH, verifyReceiptChain, type Receipt } from './receipt.js'
import {
  proofToView,
  receiptToView,
  renderReceiptHtml,
  wantsReceiptHtml,
  serializeReceiptJson,
  type ProofLike,
} from './receipt-view.js'

let prevUnsigned: string | undefined
beforeAll(() => {
  prevUnsigned = process.env.CONARIUM_AUDIT_UNSIGNED
  process.env.CONARIUM_AUDIT_UNSIGNED = '1'
})
afterAll(() => {
  if (prevUnsigned === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = prevUnsigned
})

function sampleReceipt(seq: number, prevHash: string, decision: Receipt['policy']['decision']): Receipt {
  return buildReceipt(
    {
      id: `r${seq}`,
      ts: `2026-08-14T10:00:0${seq}.000Z`,
      period: { start: '2026-08-14T10:00:00.000Z', end: '2026-08-14T10:00:01.000Z' },
      actor: { id: 'svc' },
      request: { tool: 'query', target: 'demo-db', argsHash: 'sha256:aa' },
      dataRefs: [],
      policy: { id: 'p', version: '1', decision, rulesApplied: [] },
      flags: [],
      masking: { maskedCount: decision === 'partial' ? 2 : 0, byClass: {}, rowsReturned: 3, rowCapApplied: false },
      outcome: { status: decision === 'deny' ? 'denied' : 'complete', denied: decision === 'deny' },
    },
    { seq, prevHash },
    null,
  )
}

function demoProof(overrides: Partial<ProofLike> = {}): ProofLike {
  return {
    generatedAt: '2026-08-14T08:00:00.000Z',
    engine: { name: 'conarium', version: '0.2.7' },
    operations: [
      { request: 'revenue by month', policy: 'allow', rowsReturned: 12, maskedCount: 0 },
      { request: 'customer list', policy: 'partial', rowsReturned: 5, maskedCount: 2, sample: '[MASKED_PII]' },
      { request: 'closed table', policy: 'deny', reason: 'not permitted by policy' },
    ],
    chain: { seq: 3, head: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', entries: 3 },
    signature: null,
    publicKey: null,
    signatureMeaning: false,
    anchor: { log: 'opentimestamps', state: 'pending', ref: 'sha256:aa' },
    verify: 'from source: node bin/conarium-verify.mjs <chain.jsonl> --pubkey <key.pem> --anchor-check',
    claim: 'These records have not been altered.',
    limitations: ['Synthetic demo data, not real customer data.', 'Anchor may be pending — Bitcoin attestation takes hours.'],
    ...overrides,
  }
}

describe('wantsReceiptHtml / serialize', () => {
  it('matches the demo negotiation rules', () => {
    expect(wantsReceiptHtml(undefined)).toBe(false)
    expect(wantsReceiptHtml('*/*')).toBe(false)
    expect(wantsReceiptHtml('text/html,application/xhtml+xml')).toBe(true)
    expect(wantsReceiptHtml('text/html', 'json')).toBe(false)
    expect(wantsReceiptHtml('application/json', 'html')).toBe(true)
  })

  it('serialize is compact JSON.stringify', () => {
    const o = { a: 1 }
    expect(serializeReceiptJson(o)).toBe(JSON.stringify(o))
  })
})

describe('renderReceiptHtml', () => {
  it('document: allow / partial / deny, pending anchor, no CDN', () => {
    const proof = demoProof()
    const before = JSON.stringify(proof)
    const html = renderReceiptHtml(proofToView(proof), { mode: 'document' })
    expect(JSON.stringify(proof)).toBe(before)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('lang="tr"')
    expect(html).toContain('Sınırlar')
    expect(html).toContain('pending')
    expect(html).toContain('/proof?format=json')
    expect(html).toContain('0.2.7')
    expect(html).toContain('class="pol allow"')
    expect(html).toContain('class="pol partial"')
    expect(html).toContain('class="pol deny"')
    expect(html.includes('fonts.googleapis.com')).toBe(false)
    expect(html.includes('cdn.')).toBe(false)
    for (const lim of proof.limitations) expect(html).toContain(lim)
  })

  it('empty operations list does not invent a sample row', () => {
    const html = renderReceiptHtml(proofToView(demoProof({ operations: [] })))
    expect(html).not.toContain('örnek makbuz')
    expect(html).not.toContain('sample receipt')
  })

  it('broken chain is red and is not labelled sağlam', () => {
    const view = proofToView(demoProof())
    view.chainIntegrity = { ok: false, brokenAt: 2, reason: 'hash mismatch', entries: 3 }
    const html = renderReceiptHtml(view, { mode: 'fragment' })
    expect(html).toContain('kırık (satır 2)')
    expect(html).toContain('chain-broken')
    expect(html).not.toContain('zincir sağlam')
  })

  it('intact chain with entries says sağlam, empty does not', () => {
    const ok = proofToView(demoProof())
    ok.chainIntegrity = { ok: true, entries: 3 }
    expect(renderReceiptHtml(ok)).toContain('zincir sağlam')
    const empty = proofToView(demoProof())
    empty.chainIntegrity = { ok: true, entries: 0 }
    expect(renderReceiptHtml(empty)).not.toContain('zincir sağlam')
  })

  it('receiptToView keeps pending and does not show a green tick when unsigned', () => {
    const r = sampleReceipt(1, RECEIPT_GENESIS_HASH, 'allow')
    r.anchor = { log: 'opentimestamps', ref: r.chain.hash, state: 'pending' }
    const html = renderReceiptHtml(receiptToView(r, { chainIntegrity: { ok: true, entries: 1 } }))
    expect(html).toContain('pending')
    expect(html).toContain('İmza yok')
    expect(html).toContain('üretilemedi')
    expect(html).not.toContain('✓')
    expect(html).not.toContain('SOC 2')
  })
})

describe('verifyReceiptChain', () => {
  it('accepts a two-receipt file and flags a hash break', () => {
    const a = sampleReceipt(1, RECEIPT_GENESIS_HASH, 'allow')
    const b = sampleReceipt(2, a.chain.hash, 'partial')
    expect(verifyReceiptChain([a, b])).toEqual({ ok: true, entries: 2 })
    const broken = { ...b, chain: { ...b.chain, hash: 'sha256:dead' } }
    const check = verifyReceiptChain([a, broken])
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.brokenAt).toBe(2)
  })
})
