/**
 * Conarium Coverage Declaration v0.1 — coverage-proof producer + verifier.
 *
 * Spec: docs/superpowers/specs/2026-08-01-coverage-proof-design.md
 *
 * CRITICAL HONESTY RULE: this module cannot say "access DID NOT HAPPEN". The only
 * thing it can say is "access was NOT RECORDED". Absence of a record is ambiguous
 * (it may never have been accessed, Conarium may have been bypassed, or logging
 * may have failed). That distinction is carried in the field names (notRecorded /
 * notRecordedObjects) and the message text ("access NOT RECORDED") — in the code,
 * not only in a comment.
 */
import { createHash } from 'crypto'
import { ulid, canonicalize, receiptHash, type Receipt } from './receipt.js'
import { type SigningKey, signHash, type VerifyKey, verifyHash } from './keys.js'

export const COVERAGE_VERSION = 'conarium-coverage/0.2' as const

export interface CoverageGap {
  /** Expected (missing) seq number. */
  expectedSeq: number
  /** First real seq after the gap. */
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
  /** Length of declaredScope. */
  declared: number
  /** Number of objects whose access was RECORDED (appeared in receipt dataRefs). */
  accessed: number
  /** Number of objects whose access was NOT RECORDED. NOT "was not accessed". */
  notRecorded: number
  /**
   * Number of receipts whose object CANNOT BE DETERMINED. A receipt with empty
   * dataRefs AND a request.target that is not an object AND a data-access tool
   * (query/search) cannot answer "which object did this touch". That is NOT the
   * same as "was not accessed" — absence of a record is ambiguous. When this
   * counter is greater than zero, the notRecorded list cannot be presented as
   * "certain"; it also appears in the verifier output.
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

/** Hash the declaration body (excluding sig). */
export function coverageHash(d: Omit<CoverageDeclaration, 'sig'>): string {
  const digest = createHash('sha256').update(canonicalize(d)).digest('hex')
  return `sha256:${digest}`
}

/**
 * Compute the seq range and contiguity from receipts.
 * Does every value in 1..N appear exactly once? If there is a gap, gaps is filled.
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
      // Find the first real seq after the gap.
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
 * Compute the decision breakdown from receipts (allow/partial/deny).
 */
export function computeDecisions(receipts: Receipt[]): CoverageDecisions {
  const out: CoverageDecisions = { allow: 0, partial: 0, deny: 0 }
  for (const r of receipts) {
    const d = r.policy.decision
    if (d === 'allow') out.allow++
    else if (d === 'partial') out.partial++
    else if (d === 'deny') out.deny++
    // An unknown decision is not silently skipped — honesty: ignoring the unknown
    // would mis-state the breakdown. The schema is limited to allow/partial/deny;
    // still, to stay fail-closed, throw if an unknown decision appears.
    else throw new Error(`coverage: unknown policy decision "${d}" in receipt ${r.id}`)
  }
  return out
}

/**
 * declaredScope ∩ receipt objects — coverage summary.
 * notRecorded = objects that are in declaredScope and NEVER appear in receipts.
 * Meaning is "access was NOT RECORDED" — not "was not accessed".
 *
 * An object's "recorded access" can be derived from TWO sources:
 *   1. dataRefs[].object (query/search result, describe_table target)
 *   2. request.target — only on tools where the target IS the object itself
 *      (describe_table). Depending on a single source invites the fault of
 *      counting access as "not recorded" when a tool left dataRefs empty.
 *
 * Do not silently count "UNKNOWN" as "ABSENT": a receipt with empty dataRefs AND
 * a target that is not an object AND a data-access tool (query/search) has an
 * indeterminate object. That cannot be read as "those objects were not accessed"
 * — it is counted separately via unassignedReceiptCount. list_tables is not data
 * access (schema listing) and is not counted.
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
    // Second evidence source: on describe_table the target already IS the object itself.
    if (r.request.tool === 'describe_table' && r.request.target) {
      recorded.add(r.request.target)
      hasObject = true
    }
    // Data-access receipt whose object cannot be determined → ambiguity counter.
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
 * Produce a coverage declaration. Deterministic (depends on receipts + declaredScope;
 * id/ts depend on the moment of production). Signed with Ed25519.
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

  // The coverage period is computed from the time the receipts COVER — not from
  // the moment they were created (r.ts). A receipt can be created a little AFTER
  // the access; a "I cover this period" claim must rest on the covered time.
  // The smallest start and the largest end are found SEPARATELY (not by sorting
  // a single array and taking first/last).
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
 * Verify the declaration signature. True if valid, false otherwise (fail-closed:
 * never returns true in any case that cannot be confirmed).
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
