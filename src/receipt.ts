/**
 * Conarium Receipt v0.4 — schema, canonicalize (JCS subset), hash, sign.
 * v0.1 / v0.2 / v0.3 receipts remain verifiable forever; an old receipt is
 * not re-hashed, not re-signed, and no fields are added.
 * Spec: docs/superpowers/specs/2026-07-29-conarium-receipt-design.md §4
 *      + docs/superpowers/specs/2026-08-05-receipt-meta-provenance-design.md (v0.3)
 *
 * Knowledge-state vocabulary is ONE: model / client / (later disclosure, destination)
 * use the same `MetaSource` values. There is NO second set of DECLARED / OBSERVED /
 * VERIFIED / DERIVED — telling the same idea in two words forces the reader and
 * the verifier down two paths. `verified` is not a value either; an empty
 * "verified" field with no target we can verify becomes a vessel for a future lie.
 */
import { createHash, randomBytes } from 'crypto'
import { type SigningKey, signHash } from './keys.js'
import type { ActorAssurance } from './tokens.js'

export const RECEIPT_VERSION = 'conarium-receipt/0.4' as const

/** Single-source vocabulary. Order is the documented meaning order; new values are appended. */
export const META_SOURCES = ['protocol', 'measured', 'operator-declared', 'undeclared'] as const

export type ActorType = 'service' | 'user'
export type PolicyDecision = 'allow' | 'deny' | 'partial'
export type OutcomeStatus = 'complete' | 'error' | 'denied'

export interface ReceiptActor {
  type: ActorType
  id: string
  /** How the identity was established — the receipt carries not just who, but HOW they were known. */
  assurance: ActorAssurance
}

/**
 * WHERE a meta field's value came from.
 *
 * The receipt does not say "the model was X" — it says "declared as X" or
 * "not declared". Same discipline as `ReceiptActor.assurance`: next to the
 * value, an evidence level saying how seriously it can be taken.
 *
 *  - `protocol`           measured during the connection (MCP initialize → clientInfo)
 *  - `measured`           computed by Conarium itself (a hash, etc.) — no invention
 *  - `operator-declared`  operator declared it in config; Conarium did NOT verify
 *  - `undeclared`         not declared; fields are null, nothing was invented
 *
 * `verified` / `attested` do NOT exist TODAY. If attestation arrives, `attested` is added then.
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
 * Commitment over the result that crossed the boundary. The hash is over the
 * UTF-8 bytes of the masked / row-capped text sent to the client — the
 * request hash (`request.argsHash`) does not bind the output; this field does.
 *
 * `measured`: Conarium computed those bytes. `undeclared`: error/deny path or
 * the result was not serialized; hash/bytes are null, nothing invented.
 */
export interface ReceiptDisclosure {
  hash: string | null
  bytes: number | null
  source: Extract<MetaSource, 'measured' | 'undeclared'>
}

/**
 * Destination declaration. MCP does not carry a model; the value comes from
 * operator config. Conarium does not verify it. The policy decision is NOT
 * bound to this field — binding an access decision to an unverifiable field
 * would make the declaration look like enforcement.
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
   * If omitted, written as `undeclared`. Model identity is NOT in the MCP
   * protocol; if the operator did not declare it, the receipt says "not
   * declared" instead of hiding that.
   */
  model?: { provider: string; name: string; version: string }
  /**
   * If `source` is omitted it counts as a declaration. A value measured from
   * MCP `initialize` must arrive with `source: 'protocol'` — measured and
   * declared must not be mixed.
   */
  client?: { name: string; version: string; source?: MetaSource }
  /** Operator declaration (e.g. "openai/gpt-x"). Not verified. Undeclared if absent. */
  destination?: string
  request: ReceiptRequest
  dataRefs: ReceiptDataRef[]
  policy: ReceiptPolicy
  flags: string[]
  masking: ReceiptMasking
  /**
   * The exact text sent to the client (MCP `content[0].text`). The raw
   * result is not written on the receipt — only hash and byte count. Do not
   * supply it on the deny/error path; even if supplied it is ignored (no
   * invention, `undeclared`).
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
 * Makes an unproven person-claim STRUCTURALLY impossible: 'user' can only
 * be written with a verified assurance. This rule must be code, not a
 * comment — a comment is forgotten on the next change.
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
 * Model identity is NOT in the MCP protocol — the connecting client does not
 * tell the server which model it used. The value can therefore only be an
 * operator declaration, not a measurement. If there is no declaration, an
 * empty string / "unknown" / config default is NOT INVENTED: the receipt
 * says "not declared". An invented model identity makes the receipt a lie
 * against Art. 19 and collapses the product's only defensible position
 * (separating what it measured from what was declared).
 */
function buildModel(m?: { provider: string; name: string; version: string }): ReceiptModel {
  if (!m) return { source: 'undeclared', provider: null, name: null, version: null }
  return { source: 'operator-declared', provider: m.provider, name: m.name, version: m.version }
}

/**
 * Unlike model, client is ACTUALLY measurable (MCP `initialize` → `clientInfo`).
 * A measured value arrives with `source: 'protocol'`. If source is omitted it
 * counts as a declaration — marking it as measured would make the verifier
 * put extra trust in the receipt.
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
 * `brokenAt` is 1-based index in the array (line N). Does not hide a break.
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
