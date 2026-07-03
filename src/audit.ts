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

  constructor(opts: { sink?: string; consumer?: string; failClosed?: boolean } = {}) {
    this.sink = opts.sink
    this.consumer = opts.consumer || 'unknown'
    this.failClosed = opts.failClosed || false
    this.hmacKey = process.env.CONARIUM_AUDIT_HMAC_KEY
    this.validateChain()
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
    
    if (typeof args === 'string') return masked
    try {
      return JSON.parse(masked)
    } catch {
      return args
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

    full.prevHash = this.getLastHash()
    const contentToHash = JSON.stringify({ ...full, prevHash: full.prevHash })
    full.hash = createHash('sha256').update(contentToHash).digest('hex')
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
