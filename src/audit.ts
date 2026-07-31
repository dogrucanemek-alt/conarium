import { appendFileSync, readFileSync, existsSync, statSync } from 'fs'
import { createHmac } from 'crypto'
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
import {
  buildReceipt,
  hashArgs,
  RECEIPT_GENESIS_HASH,
  type Receipt,
  type ReceiptInput,
} from './receipt.js'
import type { GovernanceMetadata } from './governance.js'

export interface AuditEntry {
  timestamp: string
  actor: string
  /** Kimliğin nasıl kurulduğu. Artefakt kimi değil, NASIL bilindiğini de taşır. */
  actorAssurance?: ActorAssurance
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
  /** Ed25519 signature over entry.hash (v0.1). */
  sig?: { alg: 'Ed25519'; keyId: string; value: string }
}

/** Makbuz üretimi için gerekli meta bilgi (config'den gelir). */
export interface ReceiptMeta {
  model: { provider: string; name: string; version: string }
  client: { name: string; version: string }
}

/**
 * AuditEntry + governance metadata → ReceiptInput.
 * Makbuz gövdesine HİÇBİR ham PII/SQL girmez: argsHash zaten hash'li,
 * dataRefs sadece alan adları, masking sadece sayılar.
 */
function entryToReceiptInput(entry: AuditEntry, meta: ReceiptMeta): ReceiptInput {
  const g = (entry.governance ?? {}) as Partial<GovernanceMetadata>
  const decision: 'allow' | 'deny' | 'partial' = entry.denied
    ? 'deny'
    : (entry.maskedCount ?? 0) > 0
      ? 'partial'
      : 'allow'

  const dataRefs = (g.accessedTables ?? []).map((t) => {
    const prefix = `${t}.`
    const fields = (g.maskedFields ?? []).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
    return {
      source: entry.source ?? 'unknown',
      object: t,
      fieldsRequested: fields,
    }
  })

  return {
    period: { start: entry.timestamp, end: entry.timestamp },
    actor: { id: entry.actor, type: 'service', assurance: entry.actorAssurance ?? 'shared-token' },
    model: meta.model,
    client: meta.client,
    request: {
      tool: entry.tool,
      target: entry.target ?? '',
      argsHash: hashArgs(entry.args ?? null),
    },
    dataRefs,
    policy: {
      id: 'conarium.policy',
      version: '1',
      decision,
      rulesApplied: g.accessedFunctions ?? [],
    },
    flags: g.denyReason ? ['denied'] : [],
    masking: {
      maskedCount: entry.maskedCount ?? 0,
      byClass: {},
      rowsReturned: entry.rowsReturned ?? 0,
      rowCapApplied: Boolean(g.appliedRowCap),
    },
    outcome: { status: entry.denied ? 'denied' : 'complete', denied: entry.denied },
  }
}

let unsignedWarned = false

function warnUnsignedOnce(): void {
  if (unsignedWarned) return
  unsignedWarned = true
  console.warn(
    '[conarium:audit] CONARIUM_AUDIT_UNSIGNED=1 — audit entries are written without HMAC or Ed25519 signature. Not suitable for compliance claims.',
  )
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
  /** Sink byte size at last sync — başka yazıcı araya girdiyse stale lastHash yakalanır. */
  private sinkSize = -1

  /** Makbuz zinciri durumu — opt-in (receiptSink verilirse aktif). */
  private receiptSink?: string
  private receiptMeta?: ReceiptMeta
  private receiptLastHash = RECEIPT_GENESIS_HASH
  private receiptSeq = 0

  constructor(opts: {
    sink?: string
    consumer?: string
    failClosed?: boolean
    receiptSink?: string
    receiptMeta?: ReceiptMeta
  } = {}) {
    this.sink = opts.sink
    this.consumer = opts.consumer || 'unknown'
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
    // NOT: başka bir Audit instance araya yazarsa lastHash bayatlar — syncLastHashIfStale
    // bunu kapatır. Aynı milisaniyede iki yazıcı (gerçek yarış) dosya kilidi ister;
    // tek kullanıcılı kurulum için kabul.
    this.lastHash = this.getLastHash()
    this.sinkSize = this.currentSinkSize()

    // Makbuz üretimi opt-in: receiptSink verilirse zincir durumunu dosyadan yükle.
    if (opts.receiptSink) {
      this.receiptSink = opts.receiptSink
      this.receiptMeta = opts.receiptMeta
      // Makbuz HMAC ile imzalanamaz — yalnızca Ed25519 kabul edilir. HMAC anahtarı
      // requireSigningCapability'yi geçirir ama buildReceipt'i geçirmez; bu uyumsuzluk
      // istek yolunda (log → writeReceipt) patlardı. Yapılandırma anında yakala:
      // receiptSink açıkken Ed25519 yoksa sunucu daha ayağa kalkmadan hata versin.
      if (!this.signingKey) {
        throw new Error(
          'Audit: receiptSink is configured but no Ed25519 signing key is available — ' +
            'receipts require CONARIUM_AUDIT_SIGNING_KEY (HMAC is not sufficient for receipts). ' +
            'Set the key or remove receiptSink from config.',
        )
      }
      this.loadReceiptChainState()
    }
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
   * Başka bir yazıcı sink'e ekleme yaptıysa bellekdeki lastHash bayat kalır.
   * Size değişmediyse ucuz çık; değiştiyse kuyruğu yeniden oku.
   * İki instance'ın aynı anda yazdığı gerçek yarışı kapatmaz — dosya kilidi gerekir.
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

  /** Makbuz zincirinin son durumunu dosyadan yükle (seq + hash). */
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

  log(
    entry: Omit<AuditEntry, 'timestamp' | 'actor' | 'prevHash' | 'hash'> & {
      /** Erişimi yapan kişi. Verilmezse örnek başına sabit consumer kullanılır. */
      actor?: string
      actorAssurance?: ActorAssurance
    },
  ): AuditEntry {
    this.requireSigningCapability()

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
      // Yayılımdan SONRA ve açıkça: eskiden `actor: this.consumer` yayılımın
      // ÖNÜNDEYDİ, yani çağıran aktörü sessizce ezebiliyordu (tipte yasak,
      // çalışma zamanında serbest). Varsayılan artık belirsizliğe bırakılmıyor.
      actor: entry.actor ?? this.consumer,
      actorAssurance: entry.actorAssurance ?? 'shared-token',
    }

    if (full.args) {
      full.args = this.maskArgs(full.args)
    }

    this.syncLastHashIfStale()
    full.prevHash = this.lastHash
    // Strip sig/signature before hashing (mirrors exclusions in audit-hash).
    delete full.sig
    delete full.signature
    full.hash = computeEntryHash(full as unknown as Record<string, unknown>)
    this.lastHash = full.hash
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
        this.sinkSize = this.currentSinkSize()
      } catch (err) {
        if (this.failClosed) {
          throw new Error(`Audit sink write failed: ${(err as Error).message}`)
        }
      }
    }

    // Makbuz üretimi — opt-in (receiptSink yapılandırıldıysa).
    if (this.receiptSink && this.receiptMeta) {
      this.writeReceipt(full)
    }

    return full
  }

  /** AuditEntry'den makbuz üret, zincire ekle, receiptSink'e yaz. */
  private writeReceipt(entry: AuditEntry): void {
    // Defansif: constructor makbuz için Ed25519 şartını koyar; bu ikinci katman
    // yapılandırma kontrolünün atlandığı bir yolda (ör. alt sınıf) sessizce
    // imzasız makbuz üretilmesini engeller.
    if (!this.signingKey) {
      throw new Error(
        'Audit: cannot write receipt without an Ed25519 signing key — ' +
          'receipts require CONARIUM_AUDIT_SIGNING_KEY (HMAC is not sufficient).',
      )
    }
    const chain = {
      seq: this.receiptSeq + 1,
      prevHash: this.receiptLastHash,
    }
    const input = entryToReceiptInput(entry, this.receiptMeta!)
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
      // Fail-closed verification: if we have a key, signatures MUST match.
      // If we have neither key, do NOT silently "pass" — report unverifiable
      // unless explicitly opted into unsigned mode.
      if (this.hmacKey) {
        const expectedSignature = createHmac('sha256', this.hmacKey).update(entry.hash).digest('hex')
        if (entry.signature !== expectedSignature) {
          throw new Error('Audit sink is corrupt: entry signature mismatch.')
        }
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
