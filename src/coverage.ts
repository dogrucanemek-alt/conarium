/**
 * Conarium Coverage Declaration v0.1 — kapsama kanıtı üreticisi + doğrulayıcısı.
 *
 * Spec: docs/superpowers/specs/2026-08-01-coverage-proof-design.md
 *
 * KRİTİK DÜRÜSTLÜK KURALI: bu modül "erişim OLMADI" diyemez. Diyebildiği tek şey
 * "erişim KAYDEDİLMEDİ"dir. Kaydın yokluğu belirsizdir (gerçekten erişilmemiş de
 * olabilir, Conarium atlanmış da olabilir, loglama patlamış da olabilir). Bu ayrım
 * alan adlarına (notRecorded / notRecordedObjects) ve mesaj metnine ("access NOT
 * RECORDED") geçirilmiştir — yorumda değil, koddadır.
 */
import { createHash } from 'crypto'
import { ulid, canonicalize, receiptHash, type Receipt } from './receipt.js'
import { type SigningKey, signHash, type VerifyKey, verifyHash } from './keys.js'

export const COVERAGE_VERSION = 'conarium-coverage/0.2' as const

export interface CoverageGap {
  /** Beklenen (eksik) seq numarası. */
  expectedSeq: number
  /** Boşluktan sonra gelen ilk gerçek seq. */
  foundSeq: number
}

export interface CoverageChain {
  firstSeq: number
  lastSeq: number
  count: number
  contiguous: boolean
  gaps: CoverageGap[]
  /** False = prefix truncation is invisible. Never a silent complete. */
  windowStartPinned: boolean
  expectedFirstSeq: number | null
}

export interface CoverageDecisions {
  allow: number
  partial: number
  deny: number
}

export interface CoverageSummary {
  /** declaredScope uzunluğu. */
  declared: number
  /** Erişimi KAYDEDİLEN nesne sayısı (makbuz dataRefs'inde geçen). */
  accessed: number
  /** Erişimi KAYDEDİLMEYEN nesne sayısı. "erişilmedi" DEĞİL. */
  notRecorded: number
  /**
   * Nesnesi BELİRLENEMEYEN makbuz sayısı. dataRefs boş VE request.target nesne
   * değil VE araç veri erişimi yapan (query/search) bir makbuz "hangi nesneye
   * dokundu" sorusuna cevap veremez. Bu, "erişilmedi" demek DEĞİLDİR — kaydın
   * yokluğu belirsizdir. Bu sayacı sıfırdan büyükken notRecorded listesi "kesin"
   * gibi sunulamaz; doğrulayıcı çıktısında da görünür.
   */
  unassignedReceiptCount: number
  accessedObjects: string[]
  notRecordedObjects: string[]
}

export interface CoverageSig {
  alg: 'Ed25519'
  keyId: string
  value: string
}

export interface CoverageDeclaration {
  v: typeof COVERAGE_VERSION
  id: string
  ts: string
  period: { start: string; end: string }
  declaredScope: string[]
  chain: CoverageChain
  decisions: CoverageDecisions
  coverage: CoverageSummary
  sig: CoverageSig
}

/** Beyan gövdesinden hash hesapla (sig hariç). */
export function coverageHash(d: Omit<CoverageDeclaration, 'sig'>): string {
  const digest = createHash('sha256').update(canonicalize(d)).digest('hex')
  return `sha256:${digest}`
}

/**
 * Makbuzlardan seq aralığını ve kesintisizliği hesapla.
 * seq 1..N arası her değer tam olarak bir kez mi? Boşluk varsa gaps doldurulur.
 */
export function computeChain(
  receipts: Receipt[],
  opts: { seqFrom?: number } = {},
): CoverageChain {
  if (receipts.length === 0) {
    throw new Error('coverage: no receipts to declare coverage over (refusing silent pass)')
  }
  const seqs = receipts.map((r) => r.chain.seq).sort((a, b) => a - b)
  const firstSeq = seqs[0]!
  const lastSeq = seqs[seqs.length - 1]!
  const gaps: CoverageGap[] = []
  const pinned = opts.seqFrom != null
  if (pinned && firstSeq !== opts.seqFrom) {
    gaps.push({ expectedSeq: opts.seqFrom as number, foundSeq: firstSeq })
  }
  for (let expected = firstSeq; expected < lastSeq; expected++) {
    if (!seqs.includes(expected)) {
      // Boşluktan sonraki ilk gerçek seq'i bul.
      let foundSeq = expected + 1
      while (foundSeq <= lastSeq && !seqs.includes(foundSeq)) foundSeq++
      gaps.push({ expectedSeq: expected, foundSeq })
    }
  }
  return {
    firstSeq,
    lastSeq,
    count: receipts.length,
    contiguous: gaps.length === 0,
    gaps,
    windowStartPinned: pinned,
    expectedFirstSeq: pinned ? opts.seqFrom ?? null : null,
  }
}

/**
 * Makbuzlardan karar kırılımını hesapla (allow/partial/deny).
 */
export function computeDecisions(receipts: Receipt[]): CoverageDecisions {
  const out: CoverageDecisions = { allow: 0, partial: 0, deny: 0 }
  for (const r of receipts) {
    const d = r.policy.decision
    if (d === 'allow') out.allow++
    else if (d === 'partial') out.partial++
    else if (d === 'deny') out.deny++
    // Bilinmeyen karar sessizce sayılmaz — dürüstlük: bilinmeyeni yok saymak
    // kırılımı yanlış gösterir. Ama şema allow/partial/deny ile sınırlı; yine de
    // fail-closed olmak için bilinmeyen karar varsa hata ver.
    else throw new Error(`coverage: unknown policy decision "${d}" in receipt ${r.id}`)
  }
  return out
}

/**
 * declaredScope ∩ makbuz nesneleri — kapsama özeti.
 * notRecorded = declaredScope'ta olup makbuzlarda HİÇ geçmeyen nesneler.
 * Anlamı "erişim KAYDEDİLMEDİ" — "erişilmedi" değil.
 *
 * Bir nesnenin "kaydedilmiş erişimi" İKİ kaynaktan çıkarılabilir:
 *   1. dataRefs[].object (query/search sonucu, describe_table target'ı)
 *   2. request.target — yalnızca target'ın nesnenin ta kendisi olduğu araçlarda
 *      (describe_table). Tek kaynağa bağlı kalmak, bir aracın dataRefs'i boş
 *      bırakması durumunda erişimi yanlış "kaydedilmedi" sayma kusurunu davet eder.
 *
 * "BİLİNMİYOR"u sessizce "YOK" sayma: dataRefs boş VE target nesne değil VE araç
 * veri erişimi yapan (query/search) bir makbuzun hangi nesneye dokunduğu
 * belirsizdir. Bu, "o nesnelere erişilmedi" diye yorumlanamaz — unassignedReceiptCount
 * ile ayrıca sayılır. list_tables veri erişimi değil (sema listeleme), sayılmaz.
 */
export function computeCoverage(receipts: Receipt[], declaredScope: string[]): CoverageSummary {
  const recorded = new Set<string>()
  let unassignedReceiptCount = 0
  for (const r of receipts) {
    let hasObject = false
    for (const ref of r.dataRefs) {
      recorded.add(ref.object)
      hasObject = true
    }
    // İkinci kanıt kaynağı: describe_table'da target zaten nesnenin ta kendisi.
    if (r.request.tool === 'describe_table' && r.request.target) {
      recorded.add(r.request.target)
      hasObject = true
    }
    // Nesnesi belirlenemeyen veri-erişimi makbuzu → belirsizlik sayacı.
    if (!hasObject && (r.request.tool === 'query' || r.request.tool === 'search')) {
      unassignedReceiptCount++
    }
  }
  const accessedObjects = declaredScope.filter((o) => recorded.has(o))
  const notRecordedObjects = declaredScope.filter((o) => !recorded.has(o))
  return {
    declared: declaredScope.length,
    accessed: accessedObjects.length,
    notRecorded: notRecordedObjects.length,
    unassignedReceiptCount,
    accessedObjects,
    notRecordedObjects,
  }
}

/**
 * Kapsama beyanı üret. Deterministik (makbuzlara + declaredScope'a bağlı; id/ts
 * üretim anına bağlı). Ed25519 ile imzalanır.
 */
export function buildCoverageDeclaration(
  receipts: Receipt[],
  declaredScope: string[],
  key: SigningKey,
  opts: { id?: string; ts?: string; seqFrom?: number } = {},
): CoverageDeclaration {
  if (receipts.length === 0) {
    throw new Error('coverage: no receipts to declare coverage over (refusing silent pass)')
  }
  if (declaredScope.length === 0) {
    throw new Error('coverage: declaredScope is empty — nothing to declare coverage over')
  }

  const chain = computeChain(receipts, { seqFrom: opts.seqFrom })
  const decisions = computeDecisions(receipts)
  const coverage = computeCoverage(receipts, declaredScope)

  // Kapsama dönemi, makbuzların KAPSADIĞI zamandan hesaplanır — oluşturma anından
  // (r.ts) değil. Bir makbuz erişimden biraz SONRA oluşturulabilir; "bu dönemi
  // kapsıyorum" iddiası kapsanan zamana dayanmalı. En küçük start ve en büyük end
  // AYRI AYRI bulunur (tek diziyi sıralayıp ilk/son almak değil).
  let start = receipts[0].period.start
  let end = receipts[0].period.end
  for (const r of receipts) {
    if (r.period.start < start) start = r.period.start
    if (r.period.end > end) end = r.period.end
  }
  const period = { start, end }

  const body: Omit<CoverageDeclaration, 'sig'> = {
    v: COVERAGE_VERSION,
    id: opts.id ?? ulid(),
    ts: opts.ts ?? new Date().toISOString(),
    period,
    declaredScope,
    chain,
    decisions,
    coverage,
  }

  const hash = coverageHash(body)
  const sig: CoverageSig = {
    alg: 'Ed25519',
    keyId: key.keyId,
    value: signHash(key, hash),
  }
  return { ...body, sig }
}

/**
 * Beyan imzasını doğrula. Geçerliyse true, değilse false (fail-closed: emin
 * olunamayan hiçbir durumda true dönmez).
 */
export function verifyCoverageSignature(d: CoverageDeclaration, key: VerifyKey): boolean {
  if (d.sig.alg !== 'Ed25519') return false
  if (d.sig.keyId !== key.keyId) return false
  const { sig: _sig, ...body } = d
  const hash = coverageHash(body)
  return verifyHash(key, hash, d.sig.value)
}

/**
 * Re-verify each receipt Ed25519 signature. A broken sig is not COMPLETE.
 */
export function verifyReceiptSignatures(
  receipts: Receipt[],
  keys: VerifyKey[],
): { ok: true } | { ok: false; receiptId: string; reason: string } {
  const byId = new Map(keys.map((k) => [k.keyId, k]))
  for (const r of receipts) {
    const id = r.id || `seq:${r.chain?.seq}`
    if (!r.sig) return { ok: false, receiptId: id, reason: 'missing sig' }
    const key = byId.get(r.sig.keyId)
    if (!key) return { ok: false, receiptId: id, reason: `unknown keyId ${r.sig.keyId}` }
    if (receiptHash(r) !== r.chain.hash) {
      return { ok: false, receiptId: id, reason: 'hash mismatch' }
    }
    if (!verifyHash(key, r.chain.hash, r.sig.value)) {
      return { ok: false, receiptId: id, reason: 'signature cryptographically invalid' }
    }
  }
  return { ok: true }
}
