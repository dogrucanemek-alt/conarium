/**
 * Transparency-log anchoring for receipt chain heads.
 * Only hash+seq+keyId leave the host — never field names, table names, or customer data.
 *
 * Anchoring is async and non-blocking: failures leave anchor:null on the receipt.
 */
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
}

export interface AnchorSink {
  submit(payload: AnchorPayload): Promise<AnchorResult>
}

export class MemoryAnchorSink implements AnchorSink {
  readonly entries: Array<AnchorPayload & AnchorResult> = []

  async submit(payload: AnchorPayload): Promise<AnchorResult> {
    const result: AnchorResult = {
      log: 'memory',
      entryId: `mem-${this.entries.length + 1}`,
      loggedAt: new Date().toISOString(),
    }
    this.entries.push({ ...payload, ...result })
    return result
  }
}

/** Rekor-shaped sink. Network calls only when REKOR_URL is reachable; tests use MemoryAnchorSink. */
export class RekorAnchorSink implements AnchorSink {
  constructor(private readonly url: string = process.env.CONARIUM_REKOR_URL || 'https://rekor.sigstore.dev') {}

  async submit(payload: AnchorPayload): Promise<AnchorResult> {
    // Only the hash triple — never receipt body fields.
    const body = {
      hash: payload.hash,
      seq: payload.seq,
      keyId: payload.keyId,
    }
    const res = await fetch(`${this.url}/api/v1/log/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Minimal placeholder envelope — real Rekor hashedrekord wiring is manual dogfood.
        // Interface kept so Trillian swap is a one-file change.
        payload: Buffer.from(JSON.stringify(body)).toString('base64'),
      }),
    })
    if (!res.ok) {
      throw new Error(`RekorAnchorSink: HTTP ${res.status}`)
    }
    const json = (await res.json()) as Record<string, unknown>
    const entryId = Object.keys(json)[0] || `rekor-${Date.now()}`
    return {
      log: 'rekor',
      entryId,
      loggedAt: new Date().toISOString(),
      inclusionProof: json[entryId],
    }
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
