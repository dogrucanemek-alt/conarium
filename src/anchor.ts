/**
 * Transparency-log anchoring for receipt chain heads.
 * Only the chain-head **hash** leaves the host — never field names, table names, or customer data.
 *
 * Selected sink (v0.1): OpenTimestamps (see docs/RECEIPT-SPEC.md §Anchoring).
 * Rekor rejected: hashedrekord does not accept plain Ed25519 the way we sign; rekord
 * would upload content. RFC3161 TSA deferred (requires trusting a TSA).
 *
 * Anchoring is async and non-blocking: failures leave receipt.anchor null.
 * Opt-in: CONARIUM_ANCHOR_SINK=opentimestamps (default: none).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export interface AnchorPayload {
  hash: string
  seq: number
  keyId: string
}

export interface AnchorResult {
  log: string
  entryId: string
  loggedAt: string
  inclusionProof?: unknown
  /** OTS / pluggable extras */
  state?: 'pending' | 'bitcoin'
  otsBase64?: string
  bitcoinBlock?: number | null
}

export interface AnchorSink {
  submit(payload: AnchorPayload): Promise<AnchorResult>
}

/** Receipt.anchor reference shape (hash-exterior; may be filled after signing). */
export interface ReceiptAnchorRef {
  log: string
  ref: string
  state: 'pending' | 'bitcoin'
}

export interface AnchorSidecarRecord {
  seq: number
  hash: string
  log: string
  ots: string
  state: 'pending' | 'bitcoin'
  submittedAt: string
  upgradedAt: string | null
  bitcoinBlock: number | null
}

/**
 * Strip `sha256:` prefix → raw 32-byte Buffer for OpenTimestamps.
 * Trap: our chain.hash is prefixed; OTS wants bare digest bytes.
 */
export function hashPrefixToBuffer(hash: string): Buffer {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`hashPrefixToBuffer: expected 64 hex chars (optional sha256: prefix), got length ${hex.length}`)
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) {
    throw new Error(`hashPrefixToBuffer: expected 32 bytes, got ${buf.length}`)
  }
  return buf
}

export class MemoryAnchorSink implements AnchorSink {
  readonly entries: Array<AnchorPayload & AnchorResult> = []
  readonly calls: AnchorPayload[] = []

  async submit(payload: AnchorPayload): Promise<AnchorResult> {
    this.calls.push(payload)
    const result: AnchorResult = {
      log: 'memory',
      entryId: `mem-${this.entries.length + 1}`,
      loggedAt: new Date().toISOString(),
      state: 'pending',
      otsBase64: Buffer.from(`memory-ots:${payload.hash}`).toString('base64'),
    }
    this.entries.push({ ...payload, ...result })
    return result
  }
}

type OtsModule = {
  DetachedTimestampFile: {
    fromHash: (op: unknown, hash: Buffer) => OtsDetached
    deserialize: (bytes: Uint8Array | Buffer) => OtsDetached
  }
  Ops: { OpSHA256: new () => unknown }
  stamp: (detached: OtsDetached) => Promise<void>
  upgrade: (detached: OtsDetached) => Promise<boolean>
  verify: (
    detachedOts: OtsDetached,
    detached: OtsDetached,
    opts?: { ignoreBitcoinNode?: boolean; timeout?: number },
  ) => Promise<Record<string, { timestamp?: number; height?: number }> | undefined>
}

type OtsDetached = {
  serializeToBytes: () => Uint8Array | Buffer
  fileDigest?: () => Uint8Array | Buffer
  timestamp?: { fileHash?: Uint8Array | Buffer }
}

function loadOts(): OtsModule {
  // createRequire — avoids Vite/vitest resolving the CJS package via import-analysis.
  //
  // OPSİYONEL BAĞIMLILIK (2026-08-12). `javascript-opentimestamps` kendi bağımlılık
  // ağacında düzeltmesi OLMAYAN kritik açıklar taşıyor: `request` (SSRF, paket 2020'de
  // terk edildi), `web3` (güvensiz kimlik saklama), `crypto-js` (zayıf PBKDF2).
  // Çıpalama isteğe bağlı bir ek — çekirdek vaat (politika + maskeleme + makbuz) ona
  // ihtiyaç duymuyor. Zorunlu bağımlılık bırakmak, çıpalama kullanmayan HERKESE o
  // açıkları kurdurmak demekti. Artık yalnızca çıpalamayı açan kurar.
  try {
    let mod = require('javascript-opentimestamps') as OtsModule & { default?: OtsModule }
    if (mod && mod.default) mod = mod.default
    return mod
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Çıpalama için `javascript-opentimestamps` gerekiyor ama kurulu değil. ' +
        'Kurmak için: npm install javascript-opentimestamps — ya da CONARIUM_ANCHOR_SINK=none bırakın. ' +
        'O ağaç web3, elliptic, crypto-js, request, lodash çeker; 7 kritik ve 3 yüksek açık (2026-08-14). ' +
        'Varsayılan kurulumda gelmezler.'
      )
    }
    throw err
  }
}

/** Real OpenTimestamps calendar stamp. Only the 32-byte hash is sent. */
export class OpenTimestampsSink implements AnchorSink {
  constructor(
    private readonly timeoutMs: number = 30_000,
    private readonly ots: Pick<OtsModule, 'DetachedTimestampFile' | 'Ops' | 'stamp'> | null = null,
  ) {}

  async submit(payload: AnchorPayload): Promise<AnchorResult> {
    const mod = this.ots ?? loadOts()
    const hashBuf = hashPrefixToBuffer(payload.hash)
    const detached = mod.DetachedTimestampFile.fromHash(new mod.Ops.OpSHA256(), hashBuf)

    await Promise.race([
      mod.stamp(detached),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`OpenTimestampsSink: stamp timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
      }),
    ])

    const otsBytes = Buffer.from(detached.serializeToBytes())
    return {
      log: 'opentimestamps',
      entryId: payload.hash,
      loggedAt: new Date().toISOString(),
      state: 'pending',
      otsBase64: otsBytes.toString('base64'),
    }
  }
}

/** @deprecated Rekor rejected for plain Ed25519 / content upload — kept only so AnchorSink stays pluggable. */
export class RekorAnchorSink implements AnchorSink {
  constructor(private readonly url: string = process.env.CONARIUM_REKOR_URL || 'https://rekor.sigstore.dev') {}

  async submit(payload: AnchorPayload): Promise<AnchorResult> {
    throw new Error(
      `RekorAnchorSink: disabled (see RECEIPT-SPEC §Anchoring). Attempted submit of hash-only payload to ${this.url}; use OpenTimestampsSink.`,
    )
  }
}

const OTS_ADVISORY =
  'OpenTimestamps pulls javascript-opentimestamps → web3, elliptic, crypto-js, request, lodash. ' +
  'That tree has 7 critical and 3 high known advisories (measured 2026-08-14). ' +
  'Default install does not include them.'

export function createAnchorSinkFromEnv(): AnchorSink | null {
  const kind = (process.env.CONARIUM_ANCHOR_SINK || 'none').toLowerCase()
  if (kind === 'none' || kind === '' || kind === 'off') return null
  if (kind === 'opentimestamps' || kind === 'ots') {
    console.warn(OTS_ADVISORY)
    return new OpenTimestampsSink()
  }
  if (kind === 'memory') return new MemoryAnchorSink()
  throw new Error(`CONARIUM_ANCHOR_SINK unknown value "${kind}" (use opentimestamps|none)`)
}

export function anchorsPathForSink(sinkPath: string): string {
  return `${sinkPath}.anchors.jsonl`
}

export function appendAnchorSidecar(path: string, record: AnchorSidecarRecord): void {
  appendFileSync(path, JSON.stringify(record) + '\n')
}

export function readAnchorSidecar(path: string): AnchorSidecarRecord[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as AnchorSidecarRecord)
}

export function findAnchorByRef(path: string, ref: string): AnchorSidecarRecord | null {
  const rows = readAnchorSidecar(path)
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].hash === ref) return rows[i]
  }
  return null
}

export function rewriteAnchorSidecar(path: string, rows: AnchorSidecarRecord[]): void {
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

export function resultToSidecarRecord(payload: AnchorPayload, result: AnchorResult): AnchorSidecarRecord {
  if (!result.otsBase64) {
    throw new Error('resultToSidecarRecord: otsBase64 missing on AnchorResult')
  }
  return {
    seq: payload.seq,
    hash: payload.hash,
    log: result.log,
    ots: result.otsBase64,
    state: result.state ?? 'pending',
    submittedAt: result.loggedAt,
    upgradedAt: null,
    bitcoinBlock: result.bitcoinBlock ?? null,
  }
}

export function resultToReceiptAnchor(payload: AnchorPayload, result: AnchorResult): ReceiptAnchorRef {
  return {
    log: result.log,
    ref: payload.hash,
    state: result.state ?? 'pending',
  }
}

export class AnchorScheduler {
  private sinceLast = 0
  private lastAt = Date.now()
  private consecutiveFailures = 0
  private readonly everyN: number
  private readonly everyMs: number
  private readonly failWarnAfter: number

  constructor(
    private readonly sink: AnchorSink,
    opts: { everyN?: number; everyMs?: number; failWarnAfter?: number } = {},
  ) {
    this.everyN = opts.everyN ?? Number(process.env.CONARIUM_ANCHOR_EVERY_N || 100)
    this.everyMs = opts.everyMs ?? Number(process.env.CONARIUM_ANCHOR_EVERY_MS || 3_600_000)
    this.failWarnAfter = opts.failWarnAfter ?? 3
  }

  /** Non-blocking: returns anchor result or null. Never throws to caller. */
  async maybeAnchor(payload: AnchorPayload): Promise<AnchorResult | null> {
    this.sinceLast += 1
    const dueByCount = this.sinceLast >= this.everyN
    const dueByTime = Date.now() - this.lastAt >= this.everyMs
    if (!dueByCount && !dueByTime) return null

    try {
      const result = await this.sink.submit(payload)
      this.sinceLast = 0
      this.lastAt = Date.now()
      this.consecutiveFailures = 0
      return result
    } catch (err) {
      this.consecutiveFailures += 1
      const msg = err instanceof Error ? err.message : String(err)
      if (this.consecutiveFailures >= this.failWarnAfter) {
        console.error(
          `[conarium:anchor] ${this.consecutiveFailures} consecutive anchor failures: ${msg}`,
        )
      } else {
        console.warn(`[conarium:anchor] anchor failed (non-blocking): ${msg}`)
      }
      return null
    }
  }
}

/**
 * Upgrade a pending OTS proof toward Bitcoin attestation.
 * Returns updated record fields or null if unchanged / still pending.
 */
export async function upgradeOtsProof(
  otsBase64: string,
  hash: string,
  ots: OtsModule | null = null,
): Promise<{ otsBase64: string; state: 'pending' | 'bitcoin'; bitcoinBlock: number | null } | null> {
  const mod = ots ?? loadOts()
  const hashBuf = hashPrefixToBuffer(hash)
  const detached = mod.DetachedTimestampFile.fromHash(new mod.Ops.OpSHA256(), hashBuf)
  const detachedOts = mod.DetachedTimestampFile.deserialize(Buffer.from(otsBase64, 'base64'))
  const changed = await mod.upgrade(detachedOts)
  if (!changed) return null

  const verifyOpts = { ignoreBitcoinNode: true, timeout: 15_000 }
  const verified = await mod.verify(detachedOts, detached, verifyOpts)
  const btc = verified?.bitcoin
  const state: 'pending' | 'bitcoin' = btc?.height != null ? 'bitcoin' : 'pending'
  return {
    otsBase64: Buffer.from(detachedOts.serializeToBytes()).toString('base64'),
    state,
    bitcoinBlock: btc?.height ?? null,
  }
}

/** Verify an OTS proof against a chain-head hash. Used by tests; CLI duplicates for independence. */
export async function verifyOtsAgainstHash(
  otsBase64: string,
  hash: string,
  ots: OtsModule | null = null,
): Promise<{ ok: boolean; pending: boolean; detail?: string }> {
  try {
    const mod = ots ?? loadOts()
    const hashBuf = hashPrefixToBuffer(hash)
    const detached = mod.DetachedTimestampFile.fromHash(new mod.Ops.OpSHA256(), hashBuf)
    const detachedOts = mod.DetachedTimestampFile.deserialize(Buffer.from(otsBase64, 'base64'))
    const verified = await mod.verify(detachedOts, detached, { ignoreBitcoinNode: true, timeout: 15_000 })
    if (!verified || Object.keys(verified).length === 0) {
      return { ok: true, pending: true }
    }
    return { ok: true, pending: !verified.bitcoin }
  } catch (err) {
    return { ok: false, pending: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
