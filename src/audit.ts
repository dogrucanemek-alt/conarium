import { appendFileSync, readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { createHmac, timingSafeEqual } from 'crypto'
import { computeEntryHash, GENESIS_HASH } from './audit-hash.js'
import {
  loadSigningKey,
  loadTrustStore,
  signHash,
  verifyHash,
  type SigningKey,
  type VerifyKey,
  type KeyId,
} from './keys.js'
import type { ActorAssurance } from './tokens.js'
import { resolveScanCharCap } from './digit_pii.js'
import { maskSensitiveText } from './mask-text.js'
import {
  buildReceipt,
  hashArgs,
  RECEIPT_GENESIS_HASH,
  type MetaSource,
  type Receipt,
  type ReceiptDataRef,
  type ReceiptInput,
} from './receipt.js'
import type { GovernanceMetadata } from './governance.js'
import type { CustomPiiPattern, DetectorToggles } from './types.js'
import {
  compileCustomPatterns,
  type CompiledCustomPattern,
} from './custom_patterns.js'

export interface AuditEntry {
  timestamp: string
  actor: string
  /** How the identity was established. The artefact carries not just who, but HOW they were known. */
  actorAssurance?: ActorAssurance
  /** Name of the active masking profile (if any). Undefined on the base policy. */
  policyProfile?: string
  tool: string
  args?: any
  source?: string
  rowsReturned?: number
  maskedCount?: number
  denied: boolean
  status?: string
  target?: string
  reason?: string
  governance?: unknown
  /**
   * Connected client, if it reported during MCP `initialize` (`clientInfo`).
   * OVERRIDES the config declaration: a measured value outranks a declared one.
   */
  client?: { name: string; version: string; source?: MetaSource }
  /**
   * Text sent to the client. Only the hash is written to the receipt. NEVER
   * written to the audit JSONL — the result line must not leak into the audit trail.
   */
  disclosurePayload?: string
  prevHash?: string
  hash?: string
  signature?: string
  /** Ed25519 signature over entry.hash (v0.1). */
  sig?: { alg: 'Ed25519'; keyId: string; value: string }
}

/**
 * Receipt metadata. Since v0.3 BOTH are OPTIONAL — a gap is not invented;
 * it is written on the receipt as `source: 'undeclared'`.
 *
 * Why it was relaxed: model identity is not in the MCP protocol, so it cannot
 * come from anywhere unless the operator declares it. Making it required kept
 * the receipt completely shut — the "signed receipt for every access" promise
 * was therefore unmet in production. Receipts are now produced and mark the
 * unknown field as undeclared instead of hiding it.
 */
export interface ReceiptMeta {
  model?: { provider: string; name: string; version: string }
  client?: { name: string; version: string; source?: MetaSource }
  /** Operator declaration. Not verified. Policy does not read this. */
  destination?: string
}

/**
 * AuditEntry + governance metadata → ReceiptInput.
 * NO raw PII/SQL enters the receipt body: argsHash is already hashed,
 * dataRefs are field names only, masking is counts only.
 */
function entryToReceiptInput(entry: AuditEntry, meta: ReceiptMeta): ReceiptInput {
  const g = (entry.governance ?? {}) as Partial<GovernanceMetadata>
  const decision: 'allow' | 'deny' | 'partial' = entry.denied
    ? 'deny'
    : (entry.maskedCount ?? 0) > 0
      ? 'partial'
      : 'allow'

  // dataRefs — objects the receipt touched. Source varies BY TOOL:
  //  - query:   governance.accessedTables (SQL parser fills this)
  //  - search:  governance.accessedTables (server.ts fills from `_table` on result rows)
  //  - describe_table: entry.target is already the object itself → use directly
  //  - list_tables:    schema listing, NOT data-object access → empty is correct
  // Staying bound to a single source (accessedTables) left describe_table/search
  // empty and pushed the coverage claim toward a false "not recorded" — object
  // source is chosen per tool so that defect does not repeat.
  const dataRefs: ReceiptDataRef[] = []
  const seenObjects = new Set<string>()
  for (const t of g.accessedTables ?? []) {
    if (seenObjects.has(t)) continue
    seenObjects.add(t)
    // EMPTY, and for the same reason as `rulesApplied`. This field used to be
    // filled from `g.maskedFields`: the name said "fields requested", the
    // content was "fields masked". An auditor looking at the receipt would
    // read "these columns were requested" — a wrong reading, and what they
    // read is signed.
    //
    // The correct content (columns the query actually selected) can be
    // extracted from the SQL AST — `outputNamesForColumn` already produces a
    // reliability flag — but table-column qualification is built in two
    // separate places inside governance (SELECT output and nested JSON), and
    // a wrong mapping would reproduce the same defect we are trying to fix.
    // Leave empty until we can write the truth.
    //
    // What is lost: field-level masking detail. `masking.byClass` still
    // stands at class granularity. This is a regression and it is not hidden
    // — a misnamed populated field on a signed document costs more than a
    // missing field.
    dataRefs.push({ source: entry.source ?? 'unknown', object: t, fieldsRequested: [] })
  }
  if (entry.tool === 'describe_table' && entry.target && !seenObjects.has(entry.target)) {
    seenObjects.add(entry.target)
    dataRefs.push({ source: entry.source ?? 'unknown', object: entry.target, fieldsRequested: [] })
  }

  return {
    period: { start: entry.timestamp, end: entry.timestamp },
    // `type` was hardcoded as 'service'. A person connecting with a per-user
    // token was named by their own email but produced a signed proof stamped
    // `type: "service"` — the receipt was wrong about WHAT the actor is, and
    // it was signed.
    //
    // Derived from assurance instead of carrying a separate `isUser` field:
    // resolveActor is the single source (src/tokens.ts) and there
    // isUser === (assurance === 'per-user-token'). A second field would be
    // the same fact declared by two hands; that is exactly what drifts apart
    // over time.
    //
    // The verifier already knew this distinction (bin/conarium-verify.mjs:
    // type must be "service" or "user", and "user" + "shared-token" is
    // rejected). Production never wrote 'user', so that rule never fired.
    actor: {
      id: entry.actor,
      type: (entry.actorAssurance ?? 'shared-token') === 'per-user-token' ? 'user' : 'service',
      assurance: entry.actorAssurance ?? 'shared-token',
    },
    model: meta.model,
    // Measured client (from the protocol) overrides the config declaration.
    client: entry.client ?? meta.client,
    destination: meta.destination,
    request: {
      tool: entry.tool,
      target: entry.target ?? '',
      argsHash: hashArgs(entry.args ?? null),
    },
    dataRefs,
    policy: {
      // If a profile is in force, the receipt CARRIES it. Because it is inside
      // the hash, it cannot later be presented as "it was the base policy".
      id: entry.policyProfile ? `conarium.policy/${entry.policyProfile}` : 'conarium.policy',
      version: '1',
      decision,
      // EMPTY, and on purpose. This field used to be filled from
      // `g.accessedFunctions` — so the name said "policy rules applied" while
      // the content was "functions accessed". An auditor would read that as
      // policy rule ids and believe it.
      //
      // A misnamed populated field on a signed document is worse than an empty
      // one: empty says "we do not know", wrongly filled says "we know" and
      // lies. Real rule ids are not produced today; this stays empty until they
      // are.
      rulesApplied: [],
    },
    flags: [
      ...(g.denyReason ? ['denied'] : []),
      ...(g.flags ?? []),
    ],
    masking: {
      maskedCount: entry.maskedCount ?? 0,
      byClass: g.byClass ?? {},
      rowsReturned: entry.rowsReturned ?? 0,
      rowCapApplied: Boolean(g.appliedRowCap),
    },
    disclosurePayload: entry.denied ? undefined : entry.disclosurePayload,
    outcome: { status: entry.denied ? 'denied' : 'complete', denied: entry.denied },
  }
}

/** HMAC hex compare. `!==` on the digest leaks via timing; Node's primitive does not. */
function hmacDigestEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

let unsignedWarned = false

function warnUnsignedOnce(): void {
  if (unsignedWarned) return
  unsignedWarned = true
  console.warn(
    '[conarium:audit] CONARIUM_AUDIT_UNSIGNED=1 — audit entries are written without HMAC or Ed25519 signature. Not suitable for compliance claims.',
  )
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const heldLocks = new Map<string, number>()
let exitHookInstalled = false

function ensureLockExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const p of heldLocks.keys()) {
      try { unlinkSync(p) } catch { /* advisory */ }
    }
  })
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 15
// `wx` creates the lock file and the body lands in a second syscall, so a
// reader can catch it existing and empty. That reader cannot name an owner,
// and "owner unknown" is not "owner gone" — stealing there hands one sink to
// two live writers. Only age separates mid-creation (sub-millisecond) from a
// process that died inside that window, so an unreadable lock is honoured
// until it is this old. The cost is bounded: such a crash blocks the sink for
// LOCK_STALE_MS and, being fail-closed, blocks access with it.
const LOCK_STALE_MS = 30_000

// A lock that vanished between the failed create and this call reads as
// infinitely old, which sends the caller down the retry path — the same place
// an expired lock lands, and the next create attempt is the one that decides.
function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function acquireSinkLockOnce(sink: string): string | undefined {
  if (!existsSync(dirname(sink))) return undefined
  const lockPath = `${sink}.lock`
  const already = heldLocks.get(lockPath) ?? 0
  if (already > 0) {
    heldLocks.set(lockPath, already + 1)
    return lockPath
  }
  ensureLockExitHook()
  const body = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` refuses a pre-created path, so a planted symlink cannot redirect
      // this write. 0600 keeps the lock as private as the sink it guards.
      writeFileSync(lockPath, body, { flag: 'wx', mode: 0o600 })
      heldLocks.set(lockPath, 1)
      return lockPath
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      let otherPid: number | null = null
      try {
        const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number }
        otherPid = typeof parsed.pid === 'number' ? parsed.pid : null
      } catch {
        otherPid = null
      }
      if (otherPid === process.pid) {
        heldLocks.set(lockPath, 1)
        return lockPath
      }
      if (otherPid != null && pidAlive(otherPid)) {
        throw new Error(`another process holds the audit sink lock (pid ${otherPid})`)
      }
      if (otherPid == null && lockAgeMs(lockPath) < LOCK_STALE_MS) {
        throw new Error('another process holds the audit sink lock (pid unreadable)')
      }
      try { unlinkSync(lockPath) } catch { /* stale steal */ }
    }
  }
  throw new Error('another process holds the audit sink lock (pid unknown)')
}

function acquireSinkLock(sink: string, opts: { wait?: boolean } = {}): string | undefined {
  if (!opts.wait) return acquireSinkLockOnce(sink)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      return acquireSinkLockOnce(sink)
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('another process holds')) throw err
      if (Date.now() >= deadline) {
        throw new Error(`Audit sink lock wait timed out: ${msg}`)
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
}

/**
 * Lock order is lexicographic on the sink *paths*, never declaration order.
 * Taking audit then receipt on one path and receipt then audit on another
 * deadlocks; a gateway that fail-closes on a held lock then admits nothing.
 * Two locks, one global order. A single digest of "this process's sinks"
 * would not serialize two processes that share only the receipt file.
 */
function writeLockSinks(sink?: string, receiptSink?: string): string[] {
  return [...new Set([sink, receiptSink].filter((p): p is string => Boolean(p)))].sort()
}

function acquireWriteLocks(sinks: string[]): string[] {
  const acquired: string[] = []
  try {
    for (const sink of sinks) {
      const lockPath = acquireSinkLock(sink, { wait: true })
      if (lockPath) acquired.push(lockPath)
    }
    return acquired
  } catch (err) {
    for (let i = acquired.length - 1; i >= 0; i--) releaseSinkLock(acquired[i])
    throw err
  }
}

function releaseSinkLock(lockPath: string): void {
  const n = heldLocks.get(lockPath) ?? 0
  if (n <= 1) {
    heldLocks.delete(lockPath)
    try { unlinkSync(lockPath) } catch { /* already gone */ }
    return
  }
  heldLocks.set(lockPath, n - 1)
}

export class Audit {
  private sink?: string
  private consumer: string
  private failClosed: boolean
  private hmacKey?: string
  private signingKey: SigningKey | null
  /** keyId → verify key (current signing pubkey + CONARIUM_AUDIT_TRUST_PUBKEYS). */
  private trustStore: Map<KeyId, VerifyKey>
  private lastHash = GENESIS_HASH
  /** Sink byte size at last sync — if another writer interleaved, a stale lastHash is caught. */
  private sinkSize = -1

  /** Receipt chain state — opt-in (active when receiptSink is provided). */
  private receiptSink?: string
  private receiptMeta?: ReceiptMeta
  private receiptLastHash = RECEIPT_GENESIS_HASH
  private receiptSeq = 0
  private scanCharCap?: number
  private detectors?: DetectorToggles
  private customPatterns: CompiledCustomPattern[] = []
  private lockPath?: string

  constructor(opts: {
    sink?: string
    consumer?: string
    failClosed?: boolean
    receiptSink?: string
    receiptMeta?: ReceiptMeta
    scanCharCap?: number
    detectors?: DetectorToggles
    customPatterns?: CustomPiiPattern[]
  } = {}) {
    this.sink = opts.sink
    if (this.sink) this.lockPath = acquireSinkLock(this.sink)
    this.consumer = opts.consumer || 'unknown'
    this.scanCharCap = opts.scanCharCap
    this.detectors = opts.detectors
    this.customPatterns = compileCustomPatterns(opts.customPatterns)
    // Fail CLOSED by default: docs promise "every access is appended". A sink write
    // failure must stop the request, not silently drop the trail. Opt out explicitly
    // with failClosed: false for throwaway/demo setups.
    this.failClosed = opts.failClosed ?? true
    this.hmacKey = process.env.CONARIUM_AUDIT_HMAC_KEY
    this.signingKey = loadSigningKey()
    this.trustStore = loadTrustStore(this.signingKey)
    // Fail fast at boot — do not wait for the first log() to discover missing keys.
    this.requireSigningCapability()
    this.validateChain()
    // Read the tail hash ONCE at startup; keep it in memory afterwards so log()
    // is O(1) instead of re-reading + splitting the whole sink on every call.
    // NOTE: if another Audit instance writes in between, lastHash goes stale —
    // syncLastHashIfStale closes that. Two writers in the same millisecond
    // (a real race) need a file lock; accepted for a single-user setup.
    this.lastHash = this.getLastHash()
    this.sinkSize = this.currentSinkSize()

    // Receipt production is opt-in: if receiptSink is set, load chain state from the file.
    if (opts.receiptSink) {
      this.receiptSink = opts.receiptSink
      this.receiptMeta = opts.receiptMeta
      // A receipt cannot be signed with HMAC — only Ed25519 is accepted. An
      // HMAC key passes requireSigningCapability but not buildReceipt; that
      // mismatch would blow up on the request path (log → writeReceipt). Catch
      // it at configuration time: if receiptSink is on and Ed25519 is missing,
      // fail before the server comes up.
      if (!this.signingKey) {
        throw new Error(
          'Audit: receiptSink is configured but no Ed25519 signing key is available — ' +
            'receipts require CONARIUM_AUDIT_SIGNING_KEY (HMAC is not sufficient for receipts). ' +
            'Set the key or remove receiptSink from config.',
        )
      }
      // v0.3: receiptMeta is NO LONGER REQUIRED.
      //
      // The old behaviour (required) came from a valid concern: an invented
      // default makes the receipt's model field (Art. 19 "model identification")
      // a lie. The concern still holds — but the fix is not "never produce a
      // receipt". Model identity is not in the MCP protocol, so it cannot come
      // from anywhere unless the operator declares it; the requirement kept
      // receipts permanently shut and the "signed receipt for every access"
      // promise unmet.
      //
      // Receipts are now produced and mark the unknown field as
      // `source: 'undeclared'` instead of INVENTING it. The no-invention rule
      // is kept; the production blocker is lifted.
      // ⚠️ The Ed25519 requirement (above) was NOT relaxed: an unsigned
      // receipt is not a receipt.
      this.loadReceiptChainState()
    }
  }

  close(): void {
    if (!this.lockPath) return
    releaseSinkLock(this.lockPath)
    this.lockPath = undefined
  }

  private requireSigningCapability(): void {
    if (this.hmacKey || this.signingKey) return
    if (process.env.CONARIUM_AUDIT_UNSIGNED === '1') {
      warnUnsignedOnce()
      return
    }
    throw new Error(
      'Audit: refusing to write unsigned entries — set CONARIUM_AUDIT_SIGNING_KEY (Ed25519) or CONARIUM_AUDIT_HMAC_KEY, or explicitly CONARIUM_AUDIT_UNSIGNED=1',
    )
  }

  private currentSinkSize(): number {
    if (!this.sink || !existsSync(this.sink)) return -1
    try {
      return statSync(this.sink).size
    } catch {
      return -1
    }
  }

  /**
   * If another writer appended to the sink, the in-memory lastHash is stale.
   * Cheap exit if size did not change; re-read the tail if it did.
   * Does not close a real race of two instances writing at once — that needs a file lock.
   */
  private syncLastHashIfStale(): void {
    if (!this.sink) return
    const size = this.currentSinkSize()
    if (size === this.sinkSize) return
    this.lastHash = this.getLastHash()
    this.sinkSize = size
  }

  private getLastHash(): string {
    if (!this.sink || !existsSync(this.sink)) return GENESIS_HASH
    const content = readFileSync(this.sink, 'utf-8').trim().split('\n').filter(Boolean)
    if (content.length === 0) return GENESIS_HASH
    const lastLine = JSON.parse(content[content.length - 1]) as AuditEntry
    if (!lastLine.hash) throw new Error('Audit sink is corrupt: last entry has no hash.')
    return lastLine.hash
  }

  /** Load the receipt chain's last state from the file (seq + hash). */
  private loadReceiptChainState(): void {
    if (!this.receiptSink || !existsSync(this.receiptSink)) return
    const content = readFileSync(this.receiptSink, 'utf-8').trim().split('\n').filter(Boolean)
    if (content.length === 0) return
    const lastLine = JSON.parse(content[content.length - 1]) as Receipt
    if (!lastLine.chain?.hash || !Number.isInteger(lastLine.chain.seq)) {
      throw new Error('Audit receipt sink is corrupt: last receipt has no chain hash/seq.')
    }
    this.receiptLastHash = lastLine.chain.hash
    this.receiptSeq = lastLine.chain.seq
  }

  /** Same pipeline as audit args — used for client-facing error text (G13). */
  maskText(value: string): string {
    return maskSensitiveText(value, {
      scanCharCap: this.scanCharCap,
      detectors: this.detectors,
      customPatterns: this.customPatterns,
    })
  }

  private maskArgs(args: any): any {
    if (!args) return args
    const str = typeof args === 'string' ? args : JSON.stringify(args)
    if (str.length > resolveScanCharCap(this.scanCharCap)) {
      return typeof args === 'string' ? '[MASKED_PII]' : { _audit: 'masked-oversize', length: str.length }
    }
    const masked = this.maskText(str)
    if (typeof args === 'string') return masked
    try {
      return JSON.parse(masked)
    } catch {
      // Fail CLOSED: if masking corrupted the JSON, never return the raw object —
      // it may still carry the secret/PII we tried to redact. Emit a safe marker.
      return { _audit: 'unserializable-after-masking', length: str.length }
    }
  }

  log(
    entry: Omit<AuditEntry, 'timestamp' | 'actor' | 'prevHash' | 'hash'> & {
      /** The person who performed the access. If omitted, the per-instance fixed consumer is used. */
      actor?: string
      actorAssurance?: ActorAssurance
    },
  ): AuditEntry {
    this.requireSigningCapability()

    const { disclosurePayload, ...persistable } = entry
    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...persistable,
      // AFTER the spread and explicitly: `actor: this.consumer` used to sit
      // BEFORE the spread, so it could silently overwrite the caller's actor
      // (forbidden by the type, free at runtime). The default is no longer
      // left to ambiguity.
      actor: entry.actor ?? this.consumer,
      actorAssurance: entry.actorAssurance ?? 'shared-token',
    }

    if (full.args) {
      full.args = this.maskArgs(full.args)
    }
    if (typeof full.reason === 'string') {
      full.reason = this.maskText(full.reason)
    }
    if (typeof full.target === 'string') {
      full.target = this.maskText(full.target)
    }
    if (full.governance != null) {
      full.governance = this.maskArgs(full.governance)
    }

    const writeLocks = acquireWriteLocks(writeLockSinks(this.sink, this.receiptSink))
    try {
      this.syncLastHashIfStale()
      full.prevHash = this.lastHash
      // Strip sig/signature before hashing (mirrors exclusions in audit-hash).
      delete full.sig
      delete full.signature
      full.hash = computeEntryHash(full as unknown as Record<string, unknown>)
      if (this.hmacKey) {
        full.signature = createHmac('sha256', this.hmacKey).update(full.hash).digest('hex')
      }
      if (this.signingKey) {
        full.sig = {
          alg: 'Ed25519',
          keyId: this.signingKey.keyId,
          value: signHash(this.signingKey, full.hash),
        }
      }

      const line = JSON.stringify(full)
      console.error(`[conarium:audit] ${line}`)

      if (this.sink) {
        try {
          appendFileSync(this.sink, line + '\n')
          this.lastHash = full.hash
          this.sinkSize = this.currentSinkSize()
        } catch (err) {
          if (this.failClosed) {
            throw new Error(`Audit sink write failed: ${(err as Error).message}`)
          }
        }
      } else {
        this.lastHash = full.hash
      }

      // Receipt production — opt-in (when receiptSink is configured).
      // disclosurePayload is not written to the audit line; it is carried only for the receipt hash.
      if (this.receiptSink) {
        this.writeReceipt(
          disclosurePayload === undefined ? full : { ...full, disclosurePayload },
        )
      }

      return full
    } finally {
      for (let i = writeLocks.length - 1; i >= 0; i--) releaseSinkLock(writeLocks[i])
    }
  }

  /** Build a receipt from AuditEntry, append to the chain, write to receiptSink. */
  private writeReceipt(entry: AuditEntry): void {
    // Defensive: the constructor requires Ed25519 for receipts; this second
    // layer stops an unsigned receipt from being produced silently on a path
    // that skipped the configuration check (e.g. a subclass).
    if (!this.signingKey) {
      throw new Error(
        'Audit: cannot write receipt without an Ed25519 signing key — ' +
          'receipts require CONARIUM_AUDIT_SIGNING_KEY (HMAC is not sufficient).',
      )
    }
    // Another process may have appended since this instance loaded the tail.
    // Reload under the write lock so seq/prevHash continue that file, not memory.
    this.loadReceiptChainState()
    const chain = {
      seq: this.receiptSeq + 1,
      prevHash: this.receiptLastHash,
    }
    const input = entryToReceiptInput(entry, this.receiptMeta ?? {})
    const receipt = buildReceipt(input, chain, this.signingKey)

    try {
      appendFileSync(this.receiptSink!, JSON.stringify(receipt) + '\n')
    } catch (err) {
      if (this.failClosed) {
        throw new Error(`Audit receipt sink write failed: ${(err as Error).message}`)
      }
      return
    }

    this.receiptLastHash = receipt.chain.hash
    this.receiptSeq = chain.seq
  }

  private validateChain(): void {
    if (!this.sink || !existsSync(this.sink)) return
    const raw = readFileSync(this.sink, 'utf-8').trim()
    if (!raw) return

    let previous = GENESIS_HASH
    /** F5 contiguity: after the first entry that carries `sig`, every later entry must too. */
    let seenSig = false
    /** Same rule for the HMAC `signature` field (2026-08-05, F1's HMAC side). */
    let seenSignature = false
    const lines = raw.split('\n').filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let entry: AuditEntry
      try {
        entry = JSON.parse(line) as AuditEntry
      } catch (err) {
        throw new Error(`Audit sink is corrupt: invalid JSON (${(err as Error).message})`)
      }

      if (entry.prevHash !== previous) {
        throw new Error('Audit sink is corrupt: hash chain prevHash mismatch.')
      }
      if (!entry.hash) {
        throw new Error('Audit sink is corrupt: missing entry hash.')
      }

      const expectedHash = computeEntryHash(entry as unknown as Record<string, unknown>)
      if (entry.hash !== expectedHash) {
        throw new Error('Audit sink is corrupt: entry hash mismatch.')
      }
      // HMAC contiguity rule — F1/F5's HMAC side (2026-08-05).
      //
      // Previously `entry.signature !== expected` was the only check, and a
      // line with NO signature at all also failed it. Result: every audit
      // file written before 07-29 (unsigned) was declared "corrupt" the
      // moment an HMAC key was supplied, and the server would not start.
      // Same concept mix-up F1 already fixed for Ed25519: *"cannot verify
      // with this key"* and *"tampered"* are not the same thing. Hit
      // production on 08-05 (Hetzner c2/c3) and HMAC had to be turned off —
      // but a setup without HMAC is open to a strip-all attack (RECEIPT-SPEC
      // known gap #4), so closing this was mandatory.
      //
      // The rule is now one-to-one symmetric with Ed25519:
      //   NO signature  + no signed line seen yet     → legacy record, accept
      //   NO signature  + a signed line already seen  → strip attempt, reject
      //   signature PRESENT but does not match        → tampering, always reject
      const presentedSig = typeof entry.signature === 'string' ? entry.signature : ''
      const hasSignature = presentedSig.length > 0
      if (hasSignature) {
        // Verification is only possible when a key is present; without a key
        // the PRESENCE of a signature still counts for contiguity, otherwise
        // "remove the key + delete the signatures" would stay open.
        if (this.hmacKey) {
          const expectedSignature = createHmac('sha256', this.hmacKey).update(entry.hash).digest('hex')
          if (!hmacDigestEqual(presentedSig, expectedSignature)) {
            throw new Error('Audit sink is corrupt: entry signature mismatch.')
          }
        }
        seenSignature = true
      } else if (seenSignature) {
        throw new Error(
          `Audit sink is corrupt: HMAC signature contiguity break at line ${i + 1} — ` +
            'an entry without a signature follows signed entries (signatures cannot be removed).',
        )
      }

      const hasSig = Boolean(entry.sig && typeof entry.sig === 'object')
      if (hasSig) {
        seenSig = true
      } else if (seenSig) {
        // Contiguity (F5): once sig appears, absence is rejected. Foreign keyId is OK.
        throw new Error(
          `Audit sink is corrupt: Ed25519 sig contiguity break at line ${i + 1} — sig required after the first signed entry.`,
        )
      }

      if (process.env.CONARIUM_AUDIT_REQUIRE_SIG === '1' && (this.hmacKey || this.signingKey)) {
        if (this.hmacKey && !hasSignature) {
          throw new Error(
            `Audit sink is corrupt: CONARIUM_AUDIT_REQUIRE_SIG=1 rejects unsigned HMAC line ${i + 1}.`,
          )
        }
        if (this.signingKey && !hasSig) {
          throw new Error(
            `Audit sink is corrupt: CONARIUM_AUDIT_REQUIRE_SIG=1 rejects unsigned Ed25519 line ${i + 1}.`,
          )
        }
      }

      // Trust-store verify (F5): any keyId in the store is accepted if crypto checks out;
      // unknown keyId fails closed. Empty store → skip Ed25519 crypto (HMAC-only / unsigned).
      if (hasSig && this.trustStore.size > 0) {
        if (!entry.sig || entry.sig.alg !== 'Ed25519') {
          throw new Error(`Audit sink is corrupt: unsupported or missing Ed25519 sig at line ${i + 1}.`)
        }
        const trusted = this.trustStore.get(entry.sig.keyId)
        if (!trusted) {
          throw new Error(
            `Audit sink is corrupt: unknown Ed25519 keyId "${entry.sig.keyId}" at line ${i + 1} (not in trust store).`,
          )
        }
        if (!verifyHash(trusted, entry.hash, entry.sig.value)) {
          throw new Error(
            `Audit sink is corrupt: entry Ed25519 signature mismatch (keyId=${entry.sig.keyId}) at line ${i + 1}.`,
          )
        }
      }

      if (!this.hmacKey && !this.signingKey && process.env.CONARIUM_AUDIT_UNSIGNED !== '1') {
        throw new Error(
          'Audit sink cannot be verified: no HMAC or Ed25519 key configured (refusing silent pass). Set a key or CONARIUM_AUDIT_UNSIGNED=1.',
        )
      }
      previous = entry.hash
    }
  }
}
