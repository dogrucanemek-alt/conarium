/**
 * Makbuz v0.3 — meta provenance (model/client KAYNAĞI).
 *
 * Kilit: makbuz "model şuydu" DEMEZ. "şu olarak beyan edildi" ya da "bildirilmedi" der.
 * Model kimliği MCP protokolünde YOK; config'e sabit yazmak Conarium'un ölçmediği bir
 * şeyi imzalaması olurdu (Md.19 "model identification"). Bu yüzden değerin yanında
 * NEREDEN geldiği de taşınır ve imzanın içindedir.
 *
 * Spec: docs/superpowers/specs/2026-08-05-receipt-meta-provenance-design.md
 */
import { describe, it, expect } from 'vitest'
import { buildReceipt, META_SOURCES, nextChainState, RECEIPT_VERSION, type ReceiptInput } from './receipt.js'

process.env.CONARIUM_AUDIT_UNSIGNED = '1'

function temelInput(): ReceiptInput {
  return {
    period: { start: '2026-08-05T08:00:00.000Z', end: '2026-08-05T08:00:02.000Z' },
    actor: { id: 'conarium_c2' },
    request: { tool: 'query', target: 'demo-db', argsHash: 'sha256:abc' },
    dataRefs: [],
    policy: { id: 'conarium.config.c2', version: '3', decision: 'allow', rulesApplied: [] },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 0, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
  }
}

describe('makbuz v0.3 — meta provenance', () => {
  it('sürüm 0.4', () => {
    expect(RECEIPT_VERSION).toBe('conarium-receipt/0.4')
  })

  it('tek sözlük: measured eklendi; verified / declared / observed ikinci set değil', () => {
    expect(META_SOURCES).toEqual(['protocol', 'measured', 'operator-declared', 'undeclared'])
    expect(META_SOURCES).not.toContain('verified')
    expect(META_SOURCES).not.toContain('attested')
    expect(META_SOURCES).not.toContain('declared')
    expect(META_SOURCES).not.toContain('observed')
    expect(META_SOURCES).not.toContain('derived')
  })

  it('model verilmezse UYDURULMAZ: source=undeclared ve üç alan da null', () => {
    const r = buildReceipt(temelInput(), nextChainState(null), null)
    expect(r.model).toEqual({ source: 'undeclared', provider: null, name: null, version: null })
  })

  it('client verilmezse undeclared — boş string ya da "unknown" uydurulmaz', () => {
    const r = buildReceipt(temelInput(), nextChainState(null), null)
    expect(r.client).toEqual({ source: 'undeclared', name: null, version: null })
  })

  it('operatör config’te model beyan ettiyse operator-declared olarak taşınır', () => {
    const inp = temelInput()
    inp.model = { provider: 'anthropic', name: 'claude-opus-5', version: '2026-05' }
    const r = buildReceipt(inp, nextChainState(null), null)
    expect(r.model).toEqual({
      source: 'operator-declared',
      provider: 'anthropic',
      name: 'claude-opus-5',
      version: '2026-05',
    })
  })

  it('client protokolden ölçüldüyse source=protocol — beyandan ayrılır', () => {
    const inp = temelInput()
    inp.client = { name: 'claude-ai', version: '1.4.0', source: 'protocol' }
    const r = buildReceipt(inp, nextChainState(null), null)
    expect(r.client).toEqual({ source: 'protocol', name: 'claude-ai', version: '1.4.0' })
  })

  it('client kaynağı belirtilmezse beyan sayılır — ölçüldü diye işaretlenmez', () => {
    const inp = temelInput()
    inp.client = { name: 'cursor', version: '2.x' }
    const r = buildReceipt(inp, nextChainState(null), null)
    expect(r.client.source).toBe('operator-declared')
  })

  it('source imzanın İÇİNDE: sonradan değiştirmek zincir hash’ini bozar', async () => {
    const { receiptHash } = await import('./receipt.js')
    const r = buildReceipt(temelInput(), nextChainState(null), null)
    const kurcalanmis = JSON.parse(JSON.stringify(r))
    // "bildirilmedi"yi "beyan edildi"ye çevirme girişimi — makbuzu olduğundan güçlü göstermek
    kurcalanmis.model.source = 'operator-declared'
    kurcalanmis.model.provider = 'anthropic'
    const { chain, sig, anchor, ...govde } = kurcalanmis
    const { hash, ...chainsiz } = chain
    expect(receiptHash({ ...govde, chain: chainsiz })).not.toBe(r.chain.hash)
  })

  it('doğrulayıcı bildirilmemiş metayı SAYAR — sessizce onaylamış gibi görünmez', async () => {
    // Bu sayım bir kez sessizce 0 döndü (receipts elemanları {file,receipt} sarmalı,
    // r.model diye okunmuştu). Testler yeşilken e2e koşusu yakaladı. Kilitleniyor.
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { writeKeyPairFiles, loadSigningKey } = await import('./keys.js')

    const dir = mkdtempSync(join(tmpdir(), 'cnr-meta-cli-'))
    const dosya = join(dir, 'receipts.jsonl')

    // Doğrulayıcı --pubkey'siz çalışmayı reddediyor (fail-closed, exit 13) — gerçek imza şart.
    const anahtar = writeKeyPairFiles(join(dir, 'k'), 'cnr-test')
    const eskiKey = process.env.CONARIUM_AUDIT_SIGNING_KEY
    const eskiId = process.env.CONARIUM_AUDIT_KEY_ID
    process.env.CONARIUM_AUDIT_SIGNING_KEY = anahtar.privatePath
    process.env.CONARIUM_AUDIT_KEY_ID = 'cnr-test'
    const key = loadSigningKey()

    const beyanli = temelInput()
    beyanli.model = { provider: 'anthropic', name: 'claude-opus-5', version: '2026-05' }
    beyanli.client = { name: 'claude-ai', version: '1.4.0', source: 'protocol' }

    const r1 = buildReceipt(temelInput(), nextChainState(null), key)      // undeclared
    const r2 = buildReceipt(beyanli, nextChainState(r1), key)             // beyan + protokol
    writeFileSync(dosya, [r1, r2].map((r) => JSON.stringify(r)).join('\n') + '\n')

    if (eskiKey === undefined) delete process.env.CONARIUM_AUDIT_SIGNING_KEY
    else process.env.CONARIUM_AUDIT_SIGNING_KEY = eskiKey
    if (eskiId === undefined) delete process.env.CONARIUM_AUDIT_KEY_ID
    else process.env.CONARIUM_AUDIT_KEY_ID = eskiId

    const cli = fileURLToPath(new URL('../bin/conarium-verify.mjs', import.meta.url))
    const res = spawnSync(process.execPath, [cli, dosya, '--pubkey', anahtar.publicPath, '--json'], {
      encoding: 'utf-8',
    })
    expect(res.status).toBe(0)
    const cikti = JSON.parse(res.stdout.trim())
    expect(cikti).toMatchObject({ ok: true, count: 2, undeclaredModel: 1, undeclaredClient: 1 })
  })

  it('undeclared makbuz GEÇERLİDİR — eksik/bozuk değil, zincire normal girer', () => {
    const ilk = buildReceipt(temelInput(), nextChainState(null), null)
    const ikinci = buildReceipt(temelInput(), nextChainState(ilk), null)
    expect(ikinci.chain.seq).toBe(2)
    expect(ikinci.chain.prevHash).toBe(ilk.chain.hash)
    expect(ikinci.model.source).toBe('undeclared')
  })
})
