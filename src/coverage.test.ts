import { createPrivateKey, createPublicKey } from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildReceipt, type Receipt, type ReceiptInput } from './receipt.js'
import { generateKeyPair, type SigningKey, type VerifyKey } from './keys.js'
import {
  buildCoverageDeclaration,
  computeChain,
  computeCoverage,
  verifyCoverageSignature,
  verifyReceiptSignatures,
  type CoverageDeclaration,
} from './coverage.js'

const KEY_ID = 'coverage-test-key'

/** Env'e dokunmadan doğrudan SigningKey + VerifyKey üret (test izolasyonu). */
function makeKey(): { signing: SigningKey; verify: VerifyKey } {
  const pair = generateKeyPair(KEY_ID)
  return {
    signing: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) },
    verify: { keyId: pair.keyId, publicKey: createPublicKey(pair.publicPem) },
  }
}

const META = {
  model: { provider: 'test', name: 'test-model', version: '1.0' },
  client: { name: 'test-client', version: '1.0' },
}

/** Belirli bir nesneye erişen bir makbuz üret. */
function makeReceipt(
  seq: number,
  prevHash: string,
  object: string,
  decision: 'allow' | 'deny' | 'partial',
  ts: string,
  key: SigningKey,
): Receipt {
  const input: ReceiptInput = {
    period: { start: ts, end: ts },
    actor: { id: 'svc', type: 'service', assurance: 'shared-token' },
    model: META.model,
    client: META.client,
    request: { tool: 'query', target: object, argsHash: 'sha256:abc' },
    dataRefs: [{ source: 'pg', object, fieldsRequested: [] }],
    policy: { id: 'p', version: '1', decision, rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: decision === 'deny' ? 'denied' : 'complete', denied: decision === 'deny' },
  }
  return buildReceipt(input, { seq, prevHash }, key)
}

/**
 * Araç ve dataRefs'i elle kontrol edilebilen makbuz üret.
 * - dataRefs boş bırakılabilir (describe_table/search/list_tables senaryoları).
 * - tool 'describe_table' ise target nesnenin ta kendisidir (ikinci kanıt kaynağı).
 */
function makeReceiptWith(
  seq: number,
  prevHash: string,
  opts: {
    tool: string
    target: string
    dataRefs?: { source: string; object: string; fieldsRequested: string[] }[]
    decision?: 'allow' | 'deny' | 'partial'
    ts?: string
  },
  key: SigningKey,
): Receipt {
  const decision = opts.decision ?? 'allow'
  const ts = opts.ts ?? `2026-08-01T0${seq}:00:00.000Z`
  const input: ReceiptInput = {
    period: { start: ts, end: ts },
    actor: { id: 'svc', type: 'service', assurance: 'shared-token' },
    model: META.model,
    client: META.client,
    request: { tool: opts.tool, target: opts.target, argsHash: 'sha256:abc' },
    dataRefs: opts.dataRefs ?? [],
    policy: { id: 'p', version: '1', decision, rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: decision === 'deny' ? 'denied' : 'complete', denied: decision === 'deny' },
  }
  return buildReceipt(input, { seq, prevHash }, key)
}

const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

describe('coverage — computeChain', () => {
  it('kesintisiz zincir → contiguous true, gaps boş', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    for (let i = 1; i <= 5; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const chain = computeChain(receipts)
    expect(chain.contiguous).toBe(true)
    expect(chain.gaps).toEqual([])
    expect(chain.count).toBe(5)
    expect(chain.firstSeq).toBe(1)
    expect(chain.lastSeq).toBe(5)
  })

  it('seq boşluğu → contiguous false, gaps boşluğun yerini söyler', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    // 1..5 üret, sonra 7..10 (6 atlanır)
    for (let i = 1; i <= 5; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    for (let i = 7; i <= 10; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const chain = computeChain(receipts)
    expect(chain.contiguous).toBe(false)
    expect(chain.gaps).toEqual([{ expectedSeq: 6, foundSeq: 7 }])
    expect(chain.count).toBe(9)
  })

  it('G21: prefix-truncated window stays internally contiguous but start is unpinned', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    for (let i = 1; i <= 5; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const window = receipts.slice(2) // seq 3..5
    const chain = computeChain(window)
    expect(chain.firstSeq).toBe(3)
    expect(chain.contiguous).toBe(true)
    expect(chain.windowStartPinned).toBe(false)
  })

  it('G21: pinning seqFrom=1 on a prefix-truncated window is not complete', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    for (let i = 1; i <= 5; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const chain = computeChain(receipts.slice(2), { seqFrom: 1 })
    expect(chain.windowStartPinned).toBe(true)
    expect(chain.expectedFirstSeq).toBe(1)
    expect(chain.contiguous).toBe(false)
    expect(chain.gaps[0]).toEqual({ expectedSeq: 1, foundSeq: 3 })
  })
})

describe('coverage — computeCoverage', () => {
  it('kapsamda olup hiç erişilmemiş nesne notRecordedObjects içinde', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    // public.customers ve public.orders'a erişildi; public.audit_logs'a erişilmedi
    for (const [obj, ts] of [
      ['public.customers', '2026-08-01T01:00:00.000Z'],
      ['public.orders', '2026-08-01T02:00:00.000Z'],
    ] as const) {
      const r = makeReceipt(receipts.length + 1, prev, obj, 'allow', ts, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const scope = ['public.customers', 'public.orders', 'public.audit_logs']
    const cov = computeCoverage(receipts, scope)
    expect(cov.declared).toBe(3)
    expect(cov.accessed).toBe(2)
    expect(cov.notRecorded).toBe(1)
    expect(cov.accessedObjects).toEqual(['public.customers', 'public.orders'])
    expect(cov.notRecordedObjects).toEqual(['public.audit_logs'])
  })

  it('describe_table makbuzunun nesnesi kapsamada ERİŞİLEN çıkar (dataRefs boş olsa bile)', () => {
    const key = makeKey()
    // describe_table: dataRefs BOŞ, target nesnenin ta kendisi (ikinci kanıt kaynağı).
    const r = makeReceiptWith(1, GENESIS, { tool: 'describe_table', target: 'public.customers' }, key.signing)
    const cov = computeCoverage([r], ['public.customers', 'public.orders'])
    expect(cov.accessed).toBe(1)
    expect(cov.accessedObjects).toEqual(['public.customers'])
    expect(cov.notRecordedObjects).toEqual(['public.orders'])
    expect(cov.unassignedReceiptCount).toBe(0)
  })

  it('atfedilemeyen makbuz (query, dataRefs boş) → unassignedReceiptCount artar', () => {
    const key = makeKey()
    // query ama dataRefs boş: hangi nesneye dokunduğu belirsiz.
    const r = makeReceiptWith(1, GENESIS, { tool: 'query', target: 'conn', dataRefs: [] }, key.signing)
    const cov = computeCoverage([r], ['public.customers'])
    expect(cov.unassignedReceiptCount).toBe(1)
    expect(cov.accessed).toBe(0)
    expect(cov.notRecordedObjects).toEqual(['public.customers'])
  })

  it('atfedilemeyen makbuz (search, dataRefs boş) → unassignedReceiptCount artar', () => {
    const key = makeKey()
    const r = makeReceiptWith(1, GENESIS, { tool: 'search', target: 'conn', dataRefs: [] }, key.signing)
    const cov = computeCoverage([r], ['public.customers'])
    expect(cov.unassignedReceiptCount).toBe(1)
  })

  it('list_tables TEK BAŞINA bir nesneyi erişilmiş GÖSTERMEZ (sema listeleme)', () => {
    const key = makeKey()
    // list_tables: dataRefs boş, target konnektör adı (nesne değil). Veri erişimi değil.
    const r = makeReceiptWith(1, GENESIS, { tool: 'list_tables', target: 'conn', dataRefs: [] }, key.signing)
    const cov = computeCoverage([r], ['public.customers'])
    expect(cov.accessed).toBe(0)
    expect(cov.notRecordedObjects).toEqual(['public.customers'])
    // list_tables veri erişimi iddia etmediği için "bilinmiyor" sayacına da düşmez.
    expect(cov.unassignedReceiptCount).toBe(0)
  })

  it('search sonucu _table taşıyorsa nesne ERİŞİLEN çıkar', () => {
    const key = makeKey()
    // search: dataRefs sonuç satırlarındaki _table'dan doldurulur (server.ts davranışı).
    const r = makeReceiptWith(
      1,
      GENESIS,
      { tool: 'search', target: 'conn', dataRefs: [{ source: 'pg', object: 'public.customers', fieldsRequested: [] }] },
      key.signing,
    )
    const cov = computeCoverage([r], ['public.customers'])
    expect(cov.accessed).toBe(1)
    expect(cov.accessedObjects).toEqual(['public.customers'])
    expect(cov.unassignedReceiptCount).toBe(0)
  })
})

describe('coverage — buildCoverageDeclaration + verify', () => {
  it('kesintisiz zincir → beyan doğru üretilir ve imza doğrulanır', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    for (let i = 1; i <= 4; i++) {
      const r = makeReceipt(i, prev, 'public.customers', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    const decl = buildCoverageDeclaration(receipts, ['public.customers', 'public.orders'], key.signing, {
      id: 'cov-1',
      ts: '2026-08-01T05:00:00.000Z',
    })
    expect(decl.v).toBe('conarium-coverage/0.2')
    expect(decl.chain.contiguous).toBe(true)
    expect(decl.chain.count).toBe(4)
    expect(decl.chain.firstSeq).toBe(1)
    expect(decl.chain.lastSeq).toBe(4)
    expect(decl.decisions.allow).toBe(4)
    expect(decl.coverage.declared).toBe(2)
    expect(decl.coverage.accessed).toBe(1)
    expect(decl.coverage.notRecorded).toBe(1)
    expect(decl.coverage.accessedObjects).toEqual(['public.customers'])
    expect(decl.coverage.notRecordedObjects).toEqual(['public.orders'])
    expect(decl.period.start).toBe('2026-08-01T01:00:00.000Z')
    expect(decl.period.end).toBe('2026-08-01T04:00:00.000Z')

    // İmza doğrulanır.
    expect(verifyCoverageSignature(decl, key.verify)).toBe(true)
  })

  it('seq boşluğu → beyan gaps ile yakalar', () => {
    const key = makeKey()
    let prev = GENESIS
    const receipts: Receipt[] = []
    for (let i = 1; i <= 3; i++) {
      const r = makeReceipt(i, prev, 'public.t', 'allow', `2026-08-01T0${i}:00:00.000Z`, key.signing)
      receipts.push(r)
      prev = r.chain.hash
    }
    // 5 (4 atlanır)
    const r5 = makeReceipt(5, prev, 'public.t', 'allow', '2026-08-01T05:00:00.000Z', key.signing)
    receipts.push(r5)

    const decl = buildCoverageDeclaration(receipts, ['public.t'], key.signing, { id: 'cov-gap' })
    expect(decl.chain.contiguous).toBe(false)
    expect(decl.chain.gaps).toEqual([{ expectedSeq: 4, foundSeq: 5 }])
    expect(verifyCoverageSignature(decl, key.verify)).toBe(true)
  })

  it('boş makbuz listesi → anlamlı hata, sessiz geçme yok', () => {
    const key = makeKey()
    expect(() => buildCoverageDeclaration([], ['public.t'], key.signing)).toThrow(
      /no receipts to declare coverage over/,
    )
  })

  it('boş declaredScope → anlamlı hata', () => {
    const key = makeKey()
    const r = makeReceipt(1, GENESIS, 'public.t', 'allow', '2026-08-01T01:00:00.000Z', key.signing)
    expect(() => buildCoverageDeclaration([r], [], key.signing)).toThrow(
      /declaredScope is empty/,
    )
  })

  it('imza bozulursa verifyCoverageSignature false döner', () => {
    const key = makeKey()
    const r = makeReceipt(1, GENESIS, 'public.t', 'allow', '2026-08-01T01:00:00.000Z', key.signing)
    const decl = buildCoverageDeclaration([r], ['public.t'], key.signing, { id: 'cov-tamper' })
    const tampered: CoverageDeclaration = { ...decl, sig: { ...decl.sig, value: Buffer.from('bad').toString('base64') } }
    expect(verifyCoverageSignature(tampered, key.verify)).toBe(false)
  })

  it('atfedilemeyen makbuz varsa unassignedReceiptCount beyanda taşınır', () => {
    const key = makeKey()
    // query ama dataRefs boş → nesnesi belirlenemeyen makbuz.
    const r = makeReceiptWith(1, GENESIS, { tool: 'query', target: 'conn', dataRefs: [] }, key.signing)
    const decl = buildCoverageDeclaration([r], ['public.customers'], key.signing, { id: 'cov-unassigned' })
    expect(decl.coverage.unassignedReceiptCount).toBe(1)
    expect(decl.coverage.accessed).toBe(0)
    expect(decl.coverage.notRecorded).toBe(1)
    expect(verifyCoverageSignature(decl, key.verify)).toBe(true)
  })

  it('G21: verifyReceiptSignatures names a tampered receipt', () => {
    const key = makeKey()
    const r = makeReceipt(1, GENESIS, 'public.t', 'allow', '2026-08-01T01:00:00.000Z', key.signing)
    const broken = { ...r, sig: { ...r.sig!, value: Buffer.from('nope').toString('base64') } }
    const out = verifyReceiptSignatures([broken], [key.verify])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.receiptId).toBe(r.id)
  })

})
