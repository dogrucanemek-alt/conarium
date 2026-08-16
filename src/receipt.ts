/**
 * Conarium Receipt v0.4 — schema, canonicalize (JCS subset), hash, sign.
 * v0.1 / v0.2 / v0.3 makbuzları sonsuza kadar doğrulanabilir kalır; eski makbuz
 * yeniden hash'lenmez, yeniden imzalanmaz, alan eklenmez.
 * Spec: docs/superpowers/specs/2026-07-29-conarium-receipt-design.md §4
 *      + docs/superpowers/specs/2026-08-05-receipt-meta-provenance-design.md (v0.3)
 *
 * Bilgi-durumu sözlüğü TEK: model / client / (ileride disclosure, destination)
 * aynı `MetaSource` değerlerini kullanır. DECLARED / OBSERVED / VERIFIED / DERIVED
 * diye ikinci bir set YOKTUR — aynı fikri iki kelimeyle anlatmak, okuyanı ve
 * doğrulayıcıyı iki yola zorlar. `verified` bir değer de değildir; doğrulayabildiğimiz
 * bir hedef yokken boş bir "verified" alanı ilerideki yalanın kabı olur.
 */
import { createHash, randomBytes } from 'crypto'
import { type SigningKey, signHash } from './keys.js'
import type { ActorAssurance } from './tokens.js'

export const RECEIPT_VERSION = 'conarium-receipt/0.4' as const

/** Tek kaynak sözlüğü. Sıra belgelenen anlam sırasıdır; yeni değer sona eklenir. */
export const META_SOURCES = ['protocol', 'measured', 'operator-declared', 'undeclared'] as const

export type ActorType = 'service' | 'user'
export type PolicyDecision = 'allow' | 'deny' | 'partial'
export type OutcomeStatus = 'complete' | 'error' | 'denied'

export interface ReceiptActor {
  type: ActorType
  id: string
  /** Kimliğin nasıl kurulduğu — makbuz kimi değil, NASIL bilindiğini de taşır. */
  assurance: ActorAssurance
}

/**
 * Bir meta alanının değeri NEREDEN geldi.
 *
 * Makbuz "model şuydu" demez — "şu olarak beyan edildi" ya da "bildirilmedi" der.
 * `ReceiptActor.assurance` ile aynı disiplin: değerin yanında, onu ne kadar
 * ciddiye alabileceğini söyleyen kanıt seviyesi taşınır.
 *
 *  - `protocol`           bağlantı sırasında ölçüldü (MCP initialize → clientInfo)
 *  - `measured`           Conarium'un kendi hesapladığı (hash gibi) — uydurma yok
 *  - `operator-declared`  operatör config'te beyan etti; Conarium DOĞRULAMADI
 *  - `undeclared`         bildirilmedi; alanlar null, uydurulmadı
 *
 * `verified` / `attested` BUGÜN YOK. Attestation gelirse o zaman `attested` eklenir.
 */
export type MetaSource = (typeof META_SOURCES)[number]

export interface ReceiptModel {
  source: MetaSource
  provider: string | null
  name: string | null
  version: string | null
}

export interface ReceiptClient {
  source: MetaSource
  name: string | null
  version: string | null
}

/**
 * Sınırdan geçen sonucun taahhüdü. Hash, istemciye giden maskelenmiş /
 * satır-tavanı uygulanmış metnin UTF-8 baytları üzerindendir — istek hash'i
 * (`request.argsHash`) çıkanı bağlamaz; bu alan bağlar.
 *
 * `measured`: Conarium o baytları hesapladı. `undeclared`: hata/ret yolu veya
 * sonuç serileştirilmedi; hash/bytes null, uydurma yok.
 */
export interface ReceiptDisclosure {
  hash: string | null
  bytes: number | null
  source: Extract<MetaSource, 'measured' | 'undeclared'>
}

/**
 * Hedef beyanı. MCP modeli taşımaz; değer operatör config'inden gelir.
 * Conarium doğrulamaz. Politika kararı bu alana BAĞLANMAZ — doğrulanamayan
 * bir alana erişim kararı bağlamak, beyanı zorlama gibi göstermek olur.
 */
export interface ReceiptDestination {
  value: string | null
  source: Extract<MetaSource, 'operator-declared' | 'undeclared'>
}

export interface ReceiptRequest {
  tool: string
  target: string
  argsHash: string
}

export interface ReceiptDataRef {
  source: string
  object: string
  fieldsRequested: string[]
}

export interface ReceiptPolicy {
  id: string
  version: string
  decision: PolicyDecision
  rulesApplied: string[]
}

export interface ReceiptMasking {
  maskedCount: number
  byClass: Record<string, number>
  rowsReturned: number
  rowCapApplied: boolean
}

export interface ReceiptOutcome {
  status: OutcomeStatus
  denied: boolean
}

export interface ReceiptChain {
  seq: number
  prevHash: string
  hash: string
}

export interface ReceiptSig {
  alg: 'Ed25519'
  keyId: string
  value: string
}

/** Hash-exterior reference; OTS proof lives in `<sink>.anchors.jsonl`. */
export interface ReceiptAnchor {
  log: string
  ref: string
  state: 'pending' | 'bitcoin'
}

export interface Receipt {
  v: typeof RECEIPT_VERSION
  id: string
  ts: string
  period: { start: string; end: string }
  actor: ReceiptActor
  model: ReceiptModel
  client: ReceiptClient
  destination: ReceiptDestination
  request: ReceiptRequest
  dataRefs: ReceiptDataRef[]
  policy: ReceiptPolicy
  flags: string[]
  masking: ReceiptMasking
  disclosure: ReceiptDisclosure
  outcome: ReceiptOutcome
  consentRef: null
  chain: ReceiptChain
  sig: ReceiptSig | null
  anchor: ReceiptAnchor | null
}

/** Input for buildReceipt — no chain/hash/sig/anchor. */
export interface ReceiptInput {
  id?: string
  ts?: string
  period: { start: string; end: string }
  actor: { id: string; type?: ActorType; assurance?: ActorAssurance }
  /**
   * Verilmezse `undeclared` yazılır. Model kimliği MCP protokolünde YOK; operatör
   * beyan etmediyse makbuz bunu gizlemek yerine "bildirilmedi" der.
   */
  model?: { provider: string; name: string; version: string }
  /**
   * `source` verilmezse beyan sayılır. MCP `initialize`'dan ölçülen değer
   * `source: 'protocol'` ile gelmelidir — ölçülmüş ile beyan edilmiş karışmasın.
   */
  client?: { name: string; version: string; source?: MetaSource }
  /** Operatör beyanı (ör. "openai/gpt-x"). Doğrulanmaz. Yoksa undeclared. */
  destination?: string
  request: ReceiptRequest
  dataRefs: ReceiptDataRef[]
  policy: ReceiptPolicy
  flags: string[]
  masking: ReceiptMasking
  /**
   * İstemciye giden metnin ta kendisi (MCP `content[0].text`). Ham sonuç
   * makbuza yazılmaz — yalnız hash ve bayt sayısı. Ret/hata yolunda verme;
   * verilse bile yok sayılır (uydurma yok, `undeclared`).
   */
  disclosurePayload?: string
  outcome: ReceiptOutcome
}

export interface ChainState {
  seq: number
  prevHash: string
}

export const RECEIPT_GENESIS_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000'

/** Crockford Base32 ULID (26 chars). No dependency. */
export function ulid(now = Date.now()): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = now
  let timePart = ''
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const rand = randomBytes(16)
  let randPart = ''
  // 80 bits of randomness → 16 crockford chars
  let acc = 0
  let bits = 0
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | rand[i]
    bits += 8
    while (bits >= 5 && randPart.length < 16) {
      randPart += ENCODING[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  while (randPart.length < 16) {
    acc = (acc << 8) | rand[randPart.length % 10]
    bits += 8
    while (bits >= 5 && randPart.length < 16) {
      randPart += ENCODING[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return timePart + randPart.slice(0, 16)
}

/**
 * RFC 8785 JCS subset: sorted object keys, no whitespace, omit undefined.
 * Sufficient for Receipt JSON (no exotic numbers / bigint).
 */
export function canonicalize(obj: unknown): string {
  return canonValue(obj)
}

function canonValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) {
    // callers should omit; if reached, treat as null omission by throwing —
    // undefined must never appear in a signed payload.
    throw new Error('canonicalize: undefined is not allowed (omit the field)')
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number')
    // JCS: use shortest round-trip; JSON.stringify is fine for our integers/simple floats
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return '[' + v.map(canonValue).join(',') + ']'
  }
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const keys = Object.keys(rec)
      .filter(k => rec[k] !== undefined)
      .sort()
    const parts: string[] = []
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + canonValue(rec[k]))
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalize: unsupported type ${typeof v}`)
}

export function receiptHash(r: unknown): string {
  const body = stripForHash(r)
  const digest = createHash('sha256').update(canonicalize(body)).digest('hex')
  return `sha256:${digest}`
}

function stripForHash(r: unknown): Record<string, unknown> {
  if (typeof r !== 'object' || r === null) {
    throw new Error('receiptHash: expected object')
  }
  const copy = { ...(r as Record<string, unknown>) }
  delete copy.hash
  delete copy.sig
  delete copy.anchor
  // hash lives under chain.hash in our schema
  if (copy.chain && typeof copy.chain === 'object' && copy.chain !== null) {
    const chain = { ...(copy.chain as Record<string, unknown>) }
    delete chain.hash
    copy.chain = chain
  }
  return copy
}

function assertSigningAllowed(key: SigningKey | null): void {
  if (key) return
  if (process.env.CONARIUM_AUDIT_UNSIGNED === '1') return
  throw new Error(
    'buildReceipt: refusing to produce an unsigned receipt — set CONARIUM_AUDIT_SIGNING_KEY (Ed25519) or CONARIUM_AUDIT_HMAC_KEY, or explicitly CONARIUM_AUDIT_UNSIGNED=1',
  )
}

/**
 * Kanıtsız kişi iddiasını YAPISAL olarak imkânsız kılar: 'user' yalnızca
 * doğrulanmış bir güvenceyle yazılabilir. Bu kural yorum değil, kod olmalı —
 * yorum bir sonraki değişiklikte unutulur.
 */
function buildActor(a: { id: string; type?: ActorType; assurance?: ActorAssurance }): ReceiptActor {
  const assurance: ActorAssurance = a.assurance ?? 'shared-token'
  const type: ActorType = a.type ?? 'service'
  if (type === 'user' && assurance === 'shared-token') {
    throw new Error(
      'buildReceipt: actor.type "user" cannot be claimed with assurance "shared-token" — ' +
        'a person may only be named when a per-user credential was verified',
    )
  }
  return { type, id: a.id, assurance }
}

/**
 * Model kimliği MCP protokolünde YOKTUR — bağlanan istemci hangi modeli kullandığını
 * sunucuya bildirmez. Bu yüzden değer ancak operatörün beyanı olabilir, ölçüm değil.
 * Beyan yoksa boş string / "unknown" / config varsayılanı UYDURULMAZ: makbuz
 * "bildirilmedi" der. Uydurulan bir model kimliği makbuzu Md.19 karşısında yalancı yapar
 * ve ürünün tek savunulabilir konumunu (ölçtüğü ile beyanı ayırmak) çürütür.
 */
function buildModel(m?: { provider: string; name: string; version: string }): ReceiptModel {
  if (!m) return { source: 'undeclared', provider: null, name: null, version: null }
  return { source: 'operator-declared', provider: m.provider, name: m.name, version: m.version }
}

/**
 * Client, modelden farklı olarak GERÇEKTEN ölçülebilir (MCP `initialize` → `clientInfo`).
 * Ölçülen değer `source: 'protocol'` ile gelir. Kaynak belirtilmemişse beyan sayılır —
 * ölçüldü diye işaretlemek, doğrulayanın makbuza fazladan güvenmesine yol açardı.
 */
function buildClient(c?: { name: string; version: string; source?: MetaSource }): ReceiptClient {
  if (!c) return { source: 'undeclared', name: null, version: null }
  return { source: c.source ?? 'operator-declared', name: c.name, version: c.version }
}

function buildDestination(value?: string): ReceiptDestination {
  if (typeof value !== 'string' || value.length === 0) {
    return { value: null, source: 'undeclared' }
  }
  return { value, source: 'operator-declared' }
}

/**
 * Build a signed (or explicitly unsigned) receipt.
 * consentRef is always null — reserved for consent binding (ISO/IEC TS 27560),
 * which is NOT part of v0.2. Naming it "v0.2" was wrong once v0.2 shipped.
 * seq must be provided via chain and is written as-is (caller owns monotonicity).
 */
export function buildReceipt(
  input: ReceiptInput,
  chain: ChainState,
  key: SigningKey | null,
): Receipt {
  assertSigningAllowed(key)

  if (!Number.isInteger(chain.seq) || chain.seq < 1) {
    throw new Error(`buildReceipt: chain.seq must be an integer >= 1, got ${chain.seq}`)
  }
  if (typeof chain.prevHash !== 'string' || chain.prevHash.length === 0) {
    throw new Error('buildReceipt: chain.prevHash is required')
  }

  const ts = input.ts ?? new Date().toISOString()
  const body: Omit<Receipt, 'chain' | 'sig' | 'anchor'> & {
    chain: Omit<ReceiptChain, 'hash'>
  } = {
    v: RECEIPT_VERSION,
    id: input.id ?? ulid(),
    ts,
    period: input.period,
    actor: buildActor(input.actor),
    model: buildModel(input.model),
    client: buildClient(input.client),
    destination: buildDestination(input.destination),
    request: input.request,
    dataRefs: input.dataRefs,
    policy: input.policy,
    flags: input.flags,
    masking: input.masking,
    disclosure: buildDisclosure(input),
    outcome: input.outcome,
    consentRef: null,
    chain: {
      seq: chain.seq,
      prevHash: chain.prevHash,
    },
  }

  const hash = receiptHash(body)
  const receipt: Receipt = {
    ...body,
    chain: { ...body.chain, hash },
    sig: null,
    anchor: null,
  }

  if (key) {
    receipt.sig = {
      alg: 'Ed25519',
      keyId: key.keyId,
      value: signHash(key, hash),
    }
  }

  return receipt
}

/** Hash a request args object without retaining raw content. */
export function hashArgs(args: unknown): string {
  const payload = typeof args === 'string' ? args : canonicalize(args ?? null)
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

/**
 * Disclosure commitment: SHA-256 of the exact UTF-8 bytes that left the
 * boundary. Same string → same hash in any process. Not JCS — the wire
 * bytes are the fact, not a re-canonicalised object.
 */
export function hashDisclosure(payload: string): { hash: string; bytes: number } {
  const buf = Buffer.from(payload, 'utf8')
  return {
    hash: `sha256:${createHash('sha256').update(buf).digest('hex')}`,
    bytes: buf.byteLength,
  }
}

const DISCLOSURE_UNDECLARED: ReceiptDisclosure = {
  hash: null,
  bytes: null,
  source: 'undeclared',
}

function buildDisclosure(input: ReceiptInput): ReceiptDisclosure {
  if (input.outcome.denied || input.outcome.status !== 'complete') {
    return DISCLOSURE_UNDECLARED
  }
  if (typeof input.disclosurePayload !== 'string') {
    return DISCLOSURE_UNDECLARED
  }
  return { ...hashDisclosure(input.disclosurePayload), source: 'measured' }
}

export function nextChainState(prev: Receipt | null): ChainState {
  if (!prev) {
    return { seq: 1, prevHash: RECEIPT_GENESIS_HASH }
  }
  return { seq: prev.chain.seq + 1, prevHash: prev.chain.hash }
}

export type ReceiptChainCheck =
  | { ok: true; entries: number }
  | { ok: false; brokenAt: number; reason: string; entries: number }

/**
 * Hash + prevHash + seq, same rules as `conarium-verify` on a single file.
 * `brokenAt` is 1-based index in the array (satır N). Does not hide a break.
 */
export function verifyReceiptChain(receipts: unknown[]): ReceiptChainCheck {
  const entries = receipts.length
  let prevHash = RECEIPT_GENESIS_HASH
  let prevSeq: number | null = null
  for (let i = 0; i < receipts.length; i++) {
    const line = i + 1
    const r = receipts[i]
    if (!r || typeof r !== 'object') {
      return { ok: false, brokenAt: line, reason: 'unreadable', entries }
    }
    const rec = r as Receipt
    if (!rec.chain || typeof rec.chain.hash !== 'string' || typeof rec.chain.prevHash !== 'string') {
      return { ok: false, brokenAt: line, reason: 'missing chain', entries }
    }
    let expected: string
    try {
      expected = receiptHash(rec)
    } catch {
      return { ok: false, brokenAt: line, reason: 'unreadable', entries }
    }
    if (rec.chain.hash !== expected) {
      return { ok: false, brokenAt: line, reason: 'hash mismatch', entries }
    }
    if (rec.chain.prevHash !== prevHash) {
      return { ok: false, brokenAt: line, reason: 'prevHash break', entries }
    }
    if (prevSeq !== null && rec.chain.seq !== prevSeq + 1) {
      return { ok: false, brokenAt: line, reason: 'seq gap', entries }
    }
    prevHash = rec.chain.hash
    prevSeq = rec.chain.seq
  }
  return { ok: true, entries }
}
