import { appendFileSync, readFileSync, existsSync } from 'fs'
import { createHash, createHmac } from 'crypto'

export interface AuditEntry {
  timestamp: string
  actor: string
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
  prevHash?: string
  hash?: string
  signature?: string
}

export class Audit {
  private sink?: string
  private consumer: string
  private failClosed: boolean
  private hmacKey?: string
  private lastHash = '0000000000000000000000000000000000000000000000000000000000000000'

  constructor(opts: { sink?: string; consumer?: string; failClosed?: boolean } = {}) {
    this.sink = opts.sink
    this.consumer = opts.consumer || 'unknown'
    this.failClosed = opts.failClosed || false
    this.hmacKey = process.env.CONARIUM_AUDIT_HMAC_KEY
    this.validateChain()
    // Read the tail hash ONCE at startup; keep it in memory afterwards so log()
    // is O(1) instead of re-reading + splitting the whole sink on every call.
    this.lastHash = this.getLastHash()
  }

  private getLastHash(): string {
    if (!this.sink || !existsSync(this.sink)) return '0000000000000000000000000000000000000000000000000000000000000000'
    const content = readFileSync(this.sink, 'utf-8').trim().split('\n').filter(Boolean)
    if (content.length === 0) return '0000000000000000000000000000000000000000000000000000000000000000'
    const lastLine = JSON.parse(content[content.length - 1]) as AuditEntry
    if (!lastLine.hash) throw new Error('Audit sink is corrupt: last entry has no hash.')
    return lastLine.hash
  }

  private maskArgs(args: any): any {
    if (!args) return args
    const str = typeof args === 'string' ? args : JSON.stringify(args)
    let masked = str
    masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[MASKED_PII]')
    masked = masked.replace(/\b[1-9][0-9]{10}\b/g, '[MASKED_PII]')
    masked = masked.replace(/(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g, '[MASKED_PII]')
    masked = masked.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[MASKED_PII]')
    // Credentials / secrets — not just PII. Keeps API keys, tokens, passwords
    // and connection-string credentials out of the audit log.
    masked = masked.replace(/\b(?:sk-[A-Za-z0-9]{12,}|sk_live_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g, '[MASKED_SECRET]')
    masked = masked.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g, '$1[MASKED_SECRET]$2')
    masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[MASKED_SECRET]')
    masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, '$1[MASKED_SECRET]')

    if (typeof args === 'string') return masked
    try {
      return JSON.parse(masked)
    } catch {
      // Fail CLOSED: if masking corrupted the JSON, never return the raw object —
      // it may still carry the secret/PII we tried to redact. Emit a safe marker.
      return { _audit: 'unserializable-after-masking', length: str.length }
    }
  }

  log(entry: Omit<AuditEntry, 'timestamp' | 'actor' | 'prevHash' | 'hash'>): void {
    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      actor: this.consumer,
      ...entry,
    }

    if (full.args) {
      full.args = this.maskArgs(full.args)
    }

    full.prevHash = this.lastHash
    const contentToHash = JSON.stringify({ ...full, prevHash: full.prevHash })
    full.hash = createHash('sha256').update(contentToHash).digest('hex')
    this.lastHash = full.hash
    if (this.hmacKey) {
      full.signature = createHmac('sha256', this.hmacKey).update(full.hash).digest('hex')
    }

    const line = JSON.stringify(full)
    console.error(`[conarium:audit] ${line}`)
    
    if (this.sink) {
      try {
        appendFileSync(this.sink, line + '\n')
      } catch (err) {
        if (this.failClosed) {
          throw new Error(`Audit sink write failed: ${(err as Error).message}`)
        }
      }
    }
  }

  private validateChain(): void {
    if (!this.sink || !existsSync(this.sink)) return
    const raw = readFileSync(this.sink, 'utf-8').trim()
    if (!raw) return

    let previous = '0000000000000000000000000000000000000000000000000000000000000000'
    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
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

      const signed = { ...entry }
      delete signed.hash
      delete signed.signature
      const expectedHash = createHash('sha256').update(JSON.stringify(signed)).digest('hex')
      if (entry.hash !== expectedHash) {
        throw new Error('Audit sink is corrupt: entry hash mismatch.')
      }
      if (this.hmacKey) {
        const expectedSignature = createHmac('sha256', this.hmacKey).update(entry.hash).digest('hex')
        if (entry.signature !== expectedSignature) {
          throw new Error('Audit sink is corrupt: entry signature mismatch.')
        }
      }
      previous = entry.hash
    }
  }
}
