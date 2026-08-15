import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'
import { writeKeyPairFiles } from './keys.js'
import type { Receipt } from './receipt.js'

// Makbuz testleri gerçek Ed25519 anahtarı gerektirir. Geçici bir anahtar üretip
// env'e koyarız; testler arasında env'i geri yükleriz.
const ENV_SIGNING = 'CONARIUM_AUDIT_SIGNING_KEY'
const ENV_KEY_ID = 'CONARIUM_AUDIT_KEY_ID'
const ENV_HMAC = 'CONARIUM_AUDIT_HMAC_KEY'
const ENV_UNSIGNED = 'CONARIUM_AUDIT_UNSIGNED'

const PREV_SIGNING_KEY = process.env[ENV_SIGNING]
const PREV_KEY_ID = process.env[ENV_KEY_ID]
const PREV_HMAC = process.env[ENV_HMAC]
const PREV_UNSIGNED = process.env[ENV_UNSIGNED]

let KEY_DIR: string
let PRIVATE_PATH: string
const KEY_ID = 'test-receipt-key'

beforeAll(() => {
  KEY_DIR = mkdtempSync(join(tmpdir(), 'conarium-receipt-test-'))
  const files = writeKeyPairFiles(join(KEY_DIR, 'audit-ed25519'), KEY_ID)
  PRIVATE_PATH = files.privatePath
  process.env[ENV_SIGNING] = PRIVATE_PATH
  process.env[ENV_KEY_ID] = KEY_ID
  // Testlerde HMAC ve UNSIGNED'ı temiz tut — her test kendi env'ini kurar.
  delete process.env[ENV_HMAC]
  delete process.env[ENV_UNSIGNED]
})

afterAll(() => {
  if (PREV_SIGNING_KEY === undefined) delete process.env[ENV_SIGNING]
  else process.env[ENV_SIGNING] = PREV_SIGNING_KEY
  if (PREV_KEY_ID === undefined) delete process.env[ENV_KEY_ID]
  else process.env[ENV_KEY_ID] = PREV_KEY_ID
  if (PREV_HMAC === undefined) delete process.env[ENV_HMAC]
  else process.env[ENV_HMAC] = PREV_HMAC
  if (PREV_UNSIGNED === undefined) delete process.env[ENV_UNSIGNED]
  else process.env[ENV_UNSIGNED] = PREV_UNSIGNED
})

const RECEIPT_META = {
  model: { provider: 'test', name: 'test-model', version: '1.0' },
  client: { name: 'test-client', version: '1.0' },
}

function readReceipts(sink: string): Receipt[] {
  if (!existsSync(sink)) return []
  return readFileSync(sink, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Receipt)
}

describe('audit receipt — yapılandırma anında imza kontrolü (regresyon)', () => {
  it('HMAC var + Ed25519 yok + receiptSink açık → Audit YAPICISI throw eder, log() değil', () => {
    // Ed25519 anahtarını geçici olarak kaldır, HMAC koy.
    delete process.env[ENV_SIGNING]
    delete process.env[ENV_KEY_ID]
    process.env[ENV_HMAC] = 'test-hmac-secret'

    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-regress-'))
    const receiptSink = join(dir, 'receipts.jsonl')

    // Constructor throw etmeli — istek yolu (log) değil.
    expect(() => new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })).toThrow(
      /receiptSink is configured but no Ed25519 signing key/,
    )

    // Env'i geri yükle.
    process.env[ENV_SIGNING] = PRIVATE_PATH
    process.env[ENV_KEY_ID] = KEY_ID
    delete process.env[ENV_HMAC]
  })

  it('receiptSink var + receiptMeta yok → makbuz ÜRETİLİR, model "undeclared" olur (v0.3)', () => {
    // v0.2'de bu durum constructor'da throw ediyordu. Kaygı doğruydu (uydurma model
    // kimliği makbuzu Md.19 karşısında yalancı yapar) ama bedeli ağırdı: model MCP
    // protokolünde hiç yok, yani operatör beyan etmedikçe zorunluluk makbuzu KALICI
    // olarak kapatıyordu. v0.3 uydurmayı değil ÜRETİMİ serbest bırakır: alan boş
    // kalır ve boş olduğu makbuza yazılır.
    //
    // ⚠️ Eski testin koruduğu asıl değer BURADA DA korunuyor: "sessiz sıfır üretim yok".
    // Fark şu ki artık sessizlik yerine makbuz var, içinde de dürüst bir boşluk.
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-meta-'))
    const receiptSink = join(dir, 'receipts.jsonl')

    const audit = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink })
    audit.log({ tool: 'query', target: 'demo.sales', denied: false })

    expect(existsSync(receiptSink)).toBe(true)
    const makbuz = JSON.parse(readFileSync(receiptSink, 'utf-8').trim().split('\n')[0])
    expect(makbuz.v).toBe('conarium-receipt/0.3')
    expect(makbuz.model).toEqual({ source: 'undeclared', provider: null, name: null, version: null })
    expect(makbuz.client).toEqual({ source: 'undeclared', name: null, version: null })
    // İmza hâlâ zorunlu — gevşetilen tek şey meta.
    expect(makbuz.sig?.alg).toBe('Ed25519')
  })

  it('Ed25519 yok + receiptSink yok → yine de çalışır (HMAC yeterli, geriye uyum)', () => {
    delete process.env[ENV_SIGNING]
    delete process.env[ENV_KEY_ID]
    process.env[ENV_HMAC] = 'test-hmac-secret'

    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-hmac-'))
    // receiptSink verilmedi — makbuz üretimi kapalı, HMAC yeterli.
    const a = new Audit({ sink: join(dir, 'audit.jsonl') })
    expect(() => a.log({ tool: 'query', denied: false })).not.toThrow()

    process.env[ENV_SIGNING] = PRIVATE_PATH
    process.env[ENV_KEY_ID] = KEY_ID
    delete process.env[ENV_HMAC]
  })
})

describe('audit receipt — mutlu yol', () => {
  it('Ed25519 + receiptSink → her log() bir imzalı makbuz üretir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-ok-'))
    const receiptSink = join(dir, 'receipts.jsonl')
    const a = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })

    a.log({ tool: 'query', target: 'public.users', denied: false, rowsReturned: 3 })
    a.log({
      tool: 'query',
      target: 'public.users',
      denied: true,
      reason: 'policy',
      governance: { denyReason: 'policy' },
    })

    const receipts = readReceipts(receiptSink)
    expect(receipts.length).toBe(2)

    // İmza var — Ed25519.
    expect(receipts[0].sig).not.toBeNull()
    expect(receipts[0].sig!.alg).toBe('Ed25519')
    expect(receipts[0].sig!.keyId).toBe(KEY_ID)
    expect(receipts[0].sig!.value.length).toBeGreaterThan(0)

    // Zincir alanları dolu.
    expect(receipts[0].chain.seq).toBe(1)
    expect(receipts[0].chain.hash).toBeTruthy()
    expect(receipts[0].chain.prevHash).toBeTruthy()

    // Karar doğru: ilk allow, ikinci deny.
    expect(receipts[0].policy.decision).toBe('allow')
    expect(receipts[1].policy.decision).toBe('deny')
    expect(receipts[1].flags).toContain('denied')
  })

  it('partial karar (masking) doğru işaretlenir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-partial-'))
    const receiptSink = join(dir, 'receipts.jsonl')
    const a = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })

    a.log({
      tool: 'query',
      target: 'public.users',
      denied: false,
      maskedCount: 2,
      rowsReturned: 5,
      governance: {
        accessedTables: ['public.users'],
        maskedFields: ['public.users.email'],
        accessedFunctions: [],
        appliedRowCap: 100,
        maskedCount: 2,
        denied: false,
      },
    })

    const receipts = readReceipts(receiptSink)
    expect(receipts.length).toBe(1)
    expect(receipts[0].policy.decision).toBe('partial')
    expect(receipts[0].masking.maskedCount).toBe(2)
    expect(receipts[0].masking.rowsReturned).toBe(5)
    expect(receipts[0].masking.rowCapApplied).toBe(true)
    // dataRefs sadece alan adı taşır — ham değer yok.
    expect(receipts[0].dataRefs[0].object).toBe('public.users')
    expect(receipts[0].dataRefs[0].fieldsRequested).toContain('email')
  })
})

describe('audit receipt — zincir sürekliliği', () => {
  it('seq artar, prevHash bir önceki hash ile eşleşir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-chain-'))
    const receiptSink = join(dir, 'receipts.jsonl')
    const a = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })

    for (let i = 0; i < 5; i++) {
      a.log({ tool: 'query', target: 'public.t', denied: false })
    }

    const receipts = readReceipts(receiptSink)
    expect(receipts.length).toBe(5)

    // seq monotonik artar.
    for (let i = 0; i < receipts.length; i++) {
      expect(receipts[i].chain.seq).toBe(i + 1)
    }

    // prevHash zinciri: her makbuzun prevHash'i bir öncekinin hash'ine eşit.
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].chain.prevHash).toBe(receipts[i - 1].chain.hash)
    }

    // İlk makbuzun prevHash'i genesis.
    expect(receipts[0].chain.prevHash).toMatch(/^sha256:0+$/)
  })

  it('yeni Audit instance zinciri devam ettirir (seq + prevHash dosyadan yüklenir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-resume-'))
    const receiptSink = join(dir, 'receipts.jsonl')

    const a1 = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })
    a1.log({ tool: 'query', target: 'public.t', denied: false })
    a1.log({ tool: 'query', target: 'public.t', denied: false })

    // Yeni instance aynı sink'i okur, zinciri devam ettirir.
    const a2 = new Audit({ sink: join(dir, 'audit.jsonl'), receiptSink, receiptMeta: RECEIPT_META })
    a2.log({ tool: 'query', target: 'public.t', denied: false })

    const receipts = readReceipts(receiptSink)
    expect(receipts.length).toBe(3)
    expect(receipts[2].chain.seq).toBe(3)
    expect(receipts[2].chain.prevHash).toBe(receipts[1].chain.hash)
  })
})

describe('audit receipt — yazılamayan sink (iddia denetimi S4)', () => {
  it('yazılamayan receiptSink + failClosed → log() throw eder, sessiz başarı yok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-fail-'))
    const receiptSink = join(dir, 'yok-boyle-bir-klasor', 'receipts.jsonl')
    const a = new Audit({
      sink: join(dir, 'audit.jsonl'),
      receiptSink,
      receiptMeta: RECEIPT_META,
    })
    expect(() => a.log({ tool: 'query', target: 'public.t', denied: false })).toThrow(
      /Audit receipt sink write failed/,
    )
  })
})

describe('audit receipt — geriye uyum', () => {
  it('receiptSink verilmezse HİÇ makbuz üretilmez', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-receipt-off-'))
    const a = new Audit({ sink: join(dir, 'audit.jsonl') })

    a.log({ tool: 'query', target: 'public.users', denied: false })
    a.log({ tool: 'query', target: 'public.users', denied: true })

    // receiptSink yok → makbuz dosyası hiç oluşmamalı.
    expect(existsSync(join(dir, 'receipts.jsonl'))).toBe(false)
  })
})
