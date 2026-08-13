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
import { maskIbansInText, prepareIbanPass } from './iban.js'
import {
  collapsePartialMask,
  maskEmbeddedEncodedPii,
  normalizePiiText,
} from './pii_normalize.js'
import {
  resolveScanCharCap,
  maskEmails,
  maskEntityEncodedEmails,
  maskNumericPii,
} from './digit_pii.js'
import { maskIps } from './ip_detect.js'
import { maskMrz } from './mrz.js'
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
import type { DetectorToggles } from './types.js'

export interface AuditEntry {
  timestamp: string
  actor: string
  /** Kimliğin nasıl kurulduğu. Artefakt kimi değil, NASIL bilindiğini de taşır. */
  actorAssurance?: ActorAssurance
  /** Yürürlükteki maskeleme profilinin adı (varsa). Taban politikada tanımsız. */
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
   * Bağlanan istemci, MCP `initialize` sırasında bildirdiyse (`clientInfo`).
   * Config'teki beyanı EZER: ölçülmüş değer, beyan edilmiş değerden üstündür.
   */
  client?: { name: string; version: string; source?: MetaSource }
  prevHash?: string
  hash?: string
  signature?: string
  /** Ed25519 signature over entry.hash (v0.1). */
  sig?: { alg: 'Ed25519'; keyId: string; value: string }
}

/**
 * Makbuz meta bilgisi. v0.3'ten beri İKİSİ DE OPSİYONEL — eksiklik uydurulmaz,
 * makbuza `source: 'undeclared'` olarak yazılır.
 *
 * Neden gevşetildi: model kimliği MCP protokolünde yok, yani operatör beyan etmedikçe
 * hiçbir yerden gelemez. Zorunlu tutmak makbuzu tamamen kapalı tutuyordu — "her erişim
 * için imzalı makbuz" vaadi bu yüzden canlıda karşılıksızdı. Artık makbuz üretilir ve
 * bilinmeyen alanı gizlemek yerine bildirilmedi olarak işaretler.
 */
export interface ReceiptMeta {
  model?: { provider: string; name: string; version: string }
  client?: { name: string; version: string; source?: MetaSource }
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

  // dataRefs — makbuzun dokunduğu nesneler. Kaynak ARACA GÖRE değişir:
  //  - query:   governance.accessedTables (SQL ayrıştırıcısı doldurur)
  //  - search:  governance.accessedTables (server.ts sonuç satırlarındaki _table'dan doldurur)
  //  - describe_table: entry.target zaten nesnenin ta kendisi → doğrudan kullan
  //  - list_tables:    sema listeleme, veri nesnesi erişimi DEĞİL → boş kalması doğru
  // Tek kaynağa (accessedTables) bağlı kalmak describe_table/search'i boş bırakıp
  // kapsama beyanını yanlış "kaydedilmedi" demeye itiyordu — bu kusurun tekrarını
  // önlemek için nesne kaynağı araca göre seçilir.
  const dataRefs: ReceiptDataRef[] = []
  const seenObjects = new Set<string>()
  for (const t of g.accessedTables ?? []) {
    if (seenObjects.has(t)) continue
    seenObjects.add(t)
    const prefix = `${t}.`
    const fields = (g.maskedFields ?? []).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
    dataRefs.push({ source: entry.source ?? 'unknown', object: t, fieldsRequested: fields })
  }
  if (entry.tool === 'describe_table' && entry.target && !seenObjects.has(entry.target)) {
    seenObjects.add(entry.target)
    dataRefs.push({ source: entry.source ?? 'unknown', object: entry.target, fieldsRequested: [] })
  }

  return {
    period: { start: entry.timestamp, end: entry.timestamp },
    actor: { id: entry.actor, type: 'service', assurance: entry.actorAssurance ?? 'shared-token' },
    model: meta.model,
    // Ölçülmüş (protokolden gelen) client, config'teki beyanı ezer.
    client: entry.client ?? meta.client,
    request: {
      tool: entry.tool,
      target: entry.target ?? '',
      argsHash: hashArgs(entry.args ?? null),
    },
    dataRefs,
    policy: {
      // Profil yürürlükteyse makbuz bunu TAŞIR. Hash'in içinde olduğu için sonradan
      // "taban politikaydı" diye gösterilemez.
      id: entry.policyProfile ? `conarium.policy/${entry.policyProfile}` : 'conarium.policy',
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
  private scanCharCap?: number
  private detectors?: DetectorToggles

  constructor(opts: {
    sink?: string
    consumer?: string
    failClosed?: boolean
    receiptSink?: string
    receiptMeta?: ReceiptMeta
    scanCharCap?: number
    detectors?: DetectorToggles
  } = {}) {
    this.sink = opts.sink
    this.consumer = opts.consumer || 'unknown'
    this.scanCharCap = opts.scanCharCap
    this.detectors = opts.detectors
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
      // v0.3: receiptMeta ARTIK ZORUNLU DEĞİL.
      //
      // Eski davranış (zorunlu) doğru bir kaygıdan doğmuştu: uydurma varsayılan, makbuzun
      // model alanını (Md.19 "model identification") yalancı yapar. Kaygı hâlâ geçerli —
      // ama çözümü "makbuzu hiç üretme" değil. Model kimliği MCP protokolünde yok, yani
      // operatör beyan etmedikçe hiçbir yerden gelemez; zorunluluk makbuzu kalıcı olarak
      // kapalı tutuyordu ve "her erişim için imzalı makbuz" vaadi karşılıksız kalıyordu.
      //
      // Artık makbuz üretilir ve bilinmeyen alanı UYDURMAK yerine `source: 'undeclared'`
      // ile işaretler. Uydurmama kuralı korunuyor, üretim engeli kalkıyor.
      // ⚠️ Ed25519 zorunluluğu (yukarıda) GEVŞETİLMEDİ: imzasız makbuz makbuz değildir.
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
    if (str.length > resolveScanCharCap(this.scanCharCap)) {
      return typeof args === 'string' ? '[MASKED_PII]' : { _audit: 'masked-oversize', length: str.length }
    }
    let masked = normalizePiiText(str)
    const ibanPass = prepareIbanPass(masked)
    masked = ibanPass.text
    masked = maskEmails(masked).text
    masked = maskEntityEncodedEmails(masked).text
    masked = maskNumericPii(masked).text
    if (this.detectors?.ip === true) masked = maskIps(masked).text
    if (this.detectors?.mrz !== false) masked = maskMrz(masked).text
    // Credentials / secrets — not just PII. Keeps API keys, tokens, passwords
    // and connection-string credentials out of the audit log.
    masked = masked.replace(/\b(?:sk-[A-Za-z0-9]{12,}|sk_live_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g, '[MASKED_SECRET]')
    masked = masked.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g, '$1[MASKED_SECRET]$2')
    masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[MASKED_SECRET]')
    masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, '$1[MASKED_SECRET]')
    masked = ibanPass.restore(masked)
    masked = collapsePartialMask(masked)
    masked = maskEmbeddedEncodedPii(masked, (s) => maskIbansInText(s).count > 0).text

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
    if (this.receiptSink) {
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
    /** Aynı kural HMAC `signature` alanı için (2026-08-05, F1'in HMAC tarafı). */
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
      // HMAC bitişiklik kuralı — F1/F5'in HMAC tarafı (2026-08-05).
      //
      // Eskiden `entry.signature !== expected` tek kontroldü ve imzası HİÇ OLMAYAN satır da
      // buna takılıyordu. Sonuç: 07-29 öncesi yazılmış (imzasız) her denetim dosyası, HMAC
      // anahtarı verildiği anda "corrupt" ilan ediliyordu ve sunucu açılmıyordu. Bu, F1'in
      // Ed25519 için düzelttiği kavram karışmasının aynısı: *"bu anahtarla doğrulanamaz"*
      // ile *"kurcalanmış"* aynı şey değildir. 08-05'te canlıda çarptı (Hetzner c2/c3) ve
      // HMAC kapatılmak zorunda kalındı — ama HMAC'siz kurulum strip-all saldırısına açık
      // (RECEIPT-SPEC known gap #4), yani bunu kapatmak zorunluydu.
      //
      // Kural artık Ed25519 ile birebir simetrik:
      //   imza YOK  + henüz imzalı satır görülmedi → eski kayıt, kabul
      //   imza YOK  + daha önce imzalı satır var   → strip girişimi, reddet
      //   imza VAR  ama eşleşmiyor                 → kurcalama, her zaman reddet
      const hasSignature = typeof entry.signature === 'string' && entry.signature.length > 0
      if (hasSignature) {
        // Doğrulama yalnızca anahtar varken yapılabilir; anahtarsızken imzanın VARLIĞI
        // yine de bitişiklik için sayılır, yoksa "anahtarı kaldır + imzaları sil" açık kalırdı.
        if (this.hmacKey) {
          const expectedSignature = createHmac('sha256', this.hmacKey).update(entry.hash).digest('hex')
          if (entry.signature !== expectedSignature) {
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
