import type { GovernancePolicy, SchemaTable, QueryResult } from './types.js'
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
import { maskSplitTcknFields } from './tckn.js'
import {
  applyCustomPatterns,
  compileCustomPatterns,
  mergeByClass,
  type CompiledCustomPattern,
} from './custom_patterns.js'
import type {
  Expr,
  ExprCall,
  ExprRef,
  From,
  OrderByStatement,
  QName,
  SelectFromStatement,
  SelectStatement,
  SelectedColumn,
  Statement,
} from 'pgsql-ast-parser'
import {
  applyPostgresRowCap,
  emitPostgresSql,
  parsePostgresSql,
  postgresLimitTarget,
} from './sql-gate/postgres.js'
import {
  findWriteToken,
  hasRowLockClause,
  isBlockedDumpFunction,
  isSafeBuiltinFunction,
  isSelectOrWith,
  normalizedSqlHead,
} from './sql-gate/rules.js'
import {
  guardSqlByDialect,
  resolveSqlDialect,
  type SqlDialect,
} from './sql-gate/dispatch.js'

export interface GovernanceMetadata {
  accessedTables: string[]
  accessedFunctions: string[]
  rewrittenSql?: string
  appliedRowCap?: number
  maskedFields: string[]
  maskedCount: number
  /** Detector / custom-rule name → hit count. Names only; no pattern text. */
  byClass?: Record<string, number>
  truncated?: boolean
  denied: boolean
  denyReason?: string
}

export interface GuardedQuery {
  sql: string
  aliases: Record<string, string>
  metadata: GovernanceMetadata
}

export interface GovernedQueryResult extends QueryResult {
  governance: GovernanceMetadata
}

export class PolicyError extends Error {
  metadata?: GovernanceMetadata

  constructor(message: string, metadata?: GovernanceMetadata) {
    super(message)
    this.name = 'PolicyError'
    this.metadata = metadata
  }
}

// Glob-ish match: exact, or prefix with trailing '*', or '*' wildcard.
function match(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase()
  const v = value.trim().toLowerCase()
  if (p === '*' || p === '*.*') return true
  if (p.endsWith('.*')) return v.startsWith(p.slice(0, -1)) // "billing.*" -> "billing."
  if (p.startsWith('*.')) return v.endsWith(p.slice(1)) // "*.email" -> ".email"
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1))
  return p === v
}

/**
 * Free-text carry-over of values the policy already calls PII.
 *
 * The gap this closes: `maskColumns` masks `customer_name`, but the same name
 * written into a `note` column left verbatim, so an operator who had masked
 * every name column still shipped names to the model. There is no name
 * detector here and none is claimed — the only strings treated as names are
 * ones THIS policy already declared, which keeps the rule deterministic and
 * explainable ("your own policy called this value PII; we honoured it
 * everywhere it appears") instead of probabilistic.
 *
 * Deliberate limits, restated in docs so nobody reads more into it:
 *  - a name that appears ONLY in free text is not detected here (see the
 *    labelled-name pass for the narrow, contextual half of that problem);
 *  - values under MIN_KNOWN_VALUE_LENGTH are ignored, because a one or two
 *    character value matches everywhere and would shred the output;
 *  - longest-first, so masking "Ayse Demir" never leaves a dangling "Demir".
 */
const MIN_KNOWN_VALUE_LENGTH = 3

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function knownValueMatchers(values: string[]): RegExp[] {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length >= MIN_KNOWN_VALUE_LENGTH) unique.add(trimmed)
  }
  return [...unique]
    .sort((a, b) => b.length - a.length)
    // Unicode-aware boundaries: \b is wrong for Turkish (it treats "ş" as a
    // boundary), so "Ali" must not match inside "Kalite" but must match at
    // "Ali," or "(Ali)".
    .map(v => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'giu'))
}

function redactKnownValues(text: string, matchers: RegExp[]): { text: string; count: number } {
  let out = text
  let count = 0
  for (const matcher of matchers) {
    out = out.replace(matcher, () => {
      count++
      return '[MASKED_PII]'
    })
  }
  return { text: out, count }
}

/**
 * A capitalised run of one to three words — the shape of a written name once
 * something else has already told us a name is coming.
 */
const NAME_SHAPE = String.raw`\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+){0,2}`

/** "Sn. Ahmet Yılmaz", "Dr. Ayşe Demir" — the title marks it, not a dictionary. */
const TITLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(Sn\.|Sayın|Sayin|Bayan|Bay|Mrs\.|Mr\.|Ms\.|Dr\.|Av\.|Prof\.)\s+(${NAME_SHAPE})`,
  'gu',
)

/**
 * "Yetkili: Ayşe Demir", "customer: John Smith" — the field label marks it.
 * The leading boundary is what keeps `filename: Rapor` out: the `name` inside
 * `filename` is preceded by a letter, so it never starts a match.
 */
const LABELLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(müşteri|musteri|yetkili|kişi|kisi|temsilci|adı soyadı|adi soyadi|ad soyad|customer|contact|full name|name)\s*:\s*(${NAME_SHAPE})`,
  'giu',
)

interface Source {
  kind: 'table' | 'derived'
  schema?: string
  table?: string
  maskedColumns?: Set<string>
}

interface SelectScope {
  sources: Map<string, Source>
}

interface AnalysisState {
  accessedTables: Set<string>
  accessedFunctions: Set<string>
}

interface SelectAnalysis {
  maskedOutputs: Set<string>
  aliases: Record<string, string>
}

/** Column-name heuristic shared by nested JSON and flat query rows (G18). */
export function maskByColumnName(column: string): '[MASKED_PII]' | '[MASKED_SECRET]' | null {
  const leaf = column.slice(column.lastIndexOf('.') + 1).toLowerCase()
  // Split-TCKN keys (`tckn_1`/`tckn_2`) are decided by checksum pairing, not by name.
  if (/(?:tckn|tc_no|tcno|tc_kimlik)[._-]?(?:1|2|left|right|part[12]|a|b)$/i.test(leaf)) {
    return null
  }
  if (leaf.includes('email') || leaf.includes('phone') || leaf.includes('tckn') || leaf.includes('card') || leaf.includes('iban')) {
    return '[MASKED_PII]'
  }
  if (/secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|\bkey\b|credential/.test(leaf)) {
    return '[MASKED_SECRET]'
  }
  return null
}

export class Governance {
  private policy: GovernancePolicy
  private profileName: string | null
  private customPatterns: CompiledCustomPattern[]

  constructor(policy: GovernancePolicy = {}, profileName: string | null = null) {
    // Fail closed here too: tests and console construct Governance by hand,
    // not only through parseConariumConfig. A typo must not become postgres.
    resolveSqlDialect(policy.dialect)
    this.policy = policy
    this.profileName = profileName
    this.customPatterns = compileCustomPatterns(policy.customPatterns)
  }

  /** Operator-declared SQL gate. Omitted dialect is postgres. */
  dialect(): SqlDialect {
    return resolveSqlDialect(this.policy.dialect)
  }

  /**
   * Shipped `query` path. Picks the gate from `policy.dialect`.
   * Does not inspect the SQL to choose a parser.
   */
  guardSql(sql: string): GuardedQuery {
    return guardSqlByDialect(this.dialect(), sql, this.policy, (s) => this.guardQuery(s))
  }

  /** Name of the masking profile in force, or null for the base policy. */
  appliedProfile(): string | null {
    return this.profileName
  }

  /**
   * Resolve the policy for a specific person.
   *
   * Masking that fits an AI agent does not fit the data controller: the owner
   * asking "which customer owes the most" needs the name. Rather than a global
   * switch that would turn the guarantee off for everyone, a named profile
   * overlays `maskColumns`/`maxRows` for one identified person, and the receipt
   * records which profile was in force (`policy.id`).
   *
   * Fail-closed at every step — anything unexpected falls back to the BASE
   * policy, never to a wider one:
   *  - no actor, or actor authenticated with a SHARED token → base. A shared
   *    token means "whoever holds this string", and handing unmasked PII to a
   *    bearer is the failure mode the product exists to prevent.
   *  - actor not listed in `actorProfiles` → base
   *  - profile name not found in `profiles` → base
   */
  forActor(actor?: { id: string; assurance: ActorAssurance }): Governance {
    if (!actor) return this
    if (actor.assurance !== 'per-user-token') return this
    const wanted = this.policy.actorProfiles?.[actor.id]
    if (!wanted) return this
    const profile = this.policy.profiles?.[wanted]
    if (!profile) {
      console.error(
        `[conarium:policy] actor "${actor.id}" is mapped to profile "${wanted}", which is not defined in policy.profiles — falling back to the base policy`,
      )
      return this
    }
    // Only these three fields. Table/tool/connector permissions are NOT overlayable,
    // so a profile cannot widen reachability — only legibility within it.
    // `maskLabelledNames` belongs to that same class: it changes how much of a
    // reachable row one identified person can read, never which rows exist.
    const merged: GovernancePolicy = {
      ...this.policy,
      ...(profile.maskColumns !== undefined ? { maskColumns: profile.maskColumns } : {}),
      ...(profile.maxRows !== undefined ? { maxRows: profile.maxRows } : {}),
      ...(profile.maskLabelledNames !== undefined ? { maskLabelledNames: profile.maskLabelledNames } : {}),
    }
    return new Governance(merged, wanted)
  }

  allowsTable(qualified: string): boolean {
    const { allowTables, denyTables } = this.policy
    if (!this.isSchemaQualifiedTable(qualified)) return false

    if (denyTables?.some(p => match(p, qualified))) return false

    // 🔒 DEFAULT-DENY (Codex denetimi 2026-07-06, P1): allowTables tanımlı DEĞİLSE hiçbir
    // tabloya izin verme. docs.html "Nothing is allowed unless you allow it" + README
    // "denied by default" bunu vaat ediyordu; eski kod (return true) TAM TERSİYDİ = güvenlik
    // ürününde vaad ihlali. Açık mod isteyen (playground/demo) explicit allowTables:['*'] verir.
    if (allowTables && allowTables.length > 0) {
      return allowTables.some(p => match(p, qualified))
    }
    return false
  }

  filterTables(tables: SchemaTable[]): SchemaTable[] {
    return tables.filter(t => this.allowsTable(`${t.schema}.${t.name}`))
  }

  /**
   * Araç izni — `allowTools` / `denyTools`.
   *
   * 🔴 2026-08-12: bu alanlar KONSOLDA düzenlenebiliyor, `types.ts`'te belgeli ve
   * testi vardı, ama kontrol yalnızca hiçbir yerden çağrılmayan `ApiGovernance`
   * içinde duruyordu — yani operatör "şu aracı kapattım" der, hiçbir şey kapanmazdı.
   * Delik değildi (yazma işlemleri connector'da zaten reddediliyor, okuma
   * `allowsTable`'dan geçiyor), ama YANLIŞ BEYANDI: arayüz bir söz veriyor, motor
   * tutmuyordu. Bu ürünün tek iddiası "söylediğini gerçekten yapmak" olduğu için
   * ölü bir politika alanı, çalışan bir açıktan daha pahalıdır.
   *
   * ⚠️ Bilerek fail-OPEN — `allowsTable`/`allowsConnector`'ın aksine. `allowTools`
   * tanımsızsa her araç geçer, çünkü asıl kapı zaten tablo politikası ve o
   * fail-closed. Burayı da fail-closed yapmak, `allowTools` yazmamış her mevcut
   * kurulumu sessizce kırardı; bu, kapatmaya çalıştığımız hatanın aynısı olurdu.
   * Bu alan koruma katmanı değil, DARALTMA katmanıdır.
   */
  allowsTool(toolName: string): boolean {
    const { allowTools, denyTools } = this.policy
    if (denyTools?.some(p => match(p, toolName))) return false
    if (allowTools && allowTools.length > 0) return allowTools.some(p => match(p, toolName))
    return true
  }

  /**
   * Fail-closed, like `allowsTable`. Previously an unset `allowConnectors`
   * meant "every connector is reachable", while an unset `allowTables` meant
   * "no table is readable" — two opposite defaults in the same policy object.
   * A gateway whose whole claim is fail-closed cannot ship that asymmetry.
   *
   * BREAKING: a config with connectors but no `allowConnectors` now reaches
   * nothing. That is deliberate — see `bootDeps`, which refuses to start with
   * a named error rather than silently serving zero connectors.
   */
  allowsConnector(connectorName: string): boolean {
    const { allowConnectors, denyConnectors } = this.policy
    if (denyConnectors?.some(p => match(p, connectorName))) return false
    if (!allowConnectors || allowConnectors.length === 0) return false
    return allowConnectors.some(p => match(p, connectorName))
  }

  guardQuery(sql: string): GuardedQuery {
    const emptyState = this.createAnalysisState()
    const norm = normalizedSqlHead(sql)
    if (!isSelectOrWith(norm)) {
      this.deny(emptyState, 'Only read-only SELECT/WITH queries are permitted.')
    }

    const writeTok = findWriteToken(norm)
    if (writeTok) this.deny(emptyState, `Blocked write operation: ${writeTok}`)

    // Row-locking clauses acquire locks (a side effect) — refuse them on governed reads.
    if (hasRowLockClause(norm)) {
      this.deny(emptyState, 'Row-locking clauses (FOR UPDATE/SHARE) are not permitted.')
    }

    let ast: Statement[]
    try {
      ast = parsePostgresSql(sql)
    } catch (err) {
      this.deny(emptyState, `Failed to parse SQL: ${(err as Error).message}`)
    }

    if (ast.length > 1) {
      this.deny(emptyState, 'Multiple statements are not permitted.')
    }

    const state = this.createAnalysisState()
    const output = this.analyzeRead(ast[0], state, new Set())

    this.applyRowCap(ast[0])
    let rewrittenSql = emitPostgresSql(ast[0])

    // KÜME İŞLEMLERİ (UNION / UNION ALL / INTERSECT / EXCEPT) — satır sınırı boşluğu.
    // applyRowCap yalnızca 'select' ve 'with' düğümlerine LIMIT ekleyebiliyor;
    // küme işlemleri limitTarget'tan undefined dönüp SESSİZCE sınırsız geçiyordu.
    // Bu, ürünün "row caps stop bulk extraction" vaadini deliyordu: politika ve
    // maskeleme çalışıyor, ama satır sayısı sınırsız.
    //
    // AST'de küme düğümü limit taşıyamıyor (yalnız type/left/right), üstelik parser
    // kullanıcının yazdığı `A UNION ALL B LIMIT 50`'yi sağ kola koyup anlamı
    // değiştiriyor. O yüzden sınır DIŞARIDAN sarmalanarak uygulanıyor — iç SQL
    // zaten doğrulanmış ve yeniden yazılmış AST'den geliyor.
    if (!this.limitTarget(ast[0])) {
      rewrittenSql = `SELECT * FROM (${rewrittenSql}) AS conarium_capped LIMIT ${this.maxRows()}`
    }
    const metadata = this.metadataFrom(state, {
      rewrittenSql,
      appliedRowCap: this.maxRows(),
      maskedFields: output.maskedOutputs,
    })

    return { sql: rewrittenSql, aliases: output.aliases, metadata }
  }

  maxRows(): number {
    return this.policy.maxRows ?? 100
  }

  redact(result: QueryResult, aliases: Record<string, string> = {}, metadata?: GovernanceMetadata): GovernedQueryResult {
    const maskedFieldLookup = new Set((metadata?.maskedFields ?? []).map(f => f.toLowerCase()))
    const maskedFields = new Set(metadata?.maskedFields ?? [])
    let maskedCount = 0
    const byClass: Record<string, number> = { ...(metadata?.byClass ?? {}) }

    // PASS 1 — collect the raw values this policy has already declared to be PII.
    // See `knownValueMatchers`: the same name that gets masked in `customer_name`
    // was leaving verbatim inside a free-text `note` on the very same row.
    const declared: string[] = []
    for (const row of result.rows) {
      for (const key of Object.keys(row)) {
        if (!this.masksColumn(row, key, aliases, maskedFieldLookup)) continue
        const value = row[key]
        if (typeof value === 'string') declared.push(value)
      }
    }
    const matchers = knownValueMatchers(declared)

    // PASS 2 — mask.
    const rows = result.rows.map(row => {
      const out: Record<string, unknown> = { ...row }
      for (const key of Object.keys(out)) {
        if (this.masksColumn(out, key, aliases, maskedFieldLookup)) {
          out[key] = '[MASKED_PII]'
          maskedFields.add(key)
          maskedCount++
          continue
        }

        const table = typeof out._table === 'string' ? out._table : ''
        const qualified = table ? `${table}.${key}` : key
        const scanRes = this.maskPII(out[key], { column: qualified })
        out[key] = scanRes.masked
        if (scanRes.count > 0) {
          maskedFields.add(key)
          maskedCount += scanRes.count
          mergeByClass(byClass, scanRes.byClass)
        }

        if (typeof out[key] === 'string' && matchers.length > 0) {
          const carried = redactKnownValues(out[key] as string, matchers)
          if (carried.count > 0) {
            out[key] = carried.text
            maskedFields.add(key)
            maskedCount += carried.count
          }
        }
      }
      const split = maskSplitTcknFields(out)
      if (split.count > 0) {
        maskedCount += split.count
        for (const k of split.maskedKeys) maskedFields.add(k)
      }
      return out
    })

    const governance = this.metadataFromMetadata(metadata, {
      maskedFields,
      maskedCount,
      byClass,
      truncated: result.rowCount > this.maxRows(),
    })

    return { ...result, rows, governance }
  }

  /** True when `key` of `row` is masked by policy (or by upstream query analysis). */
  private masksColumn(
    row: Record<string, unknown>,
    key: string,
    aliases: Record<string, string>,
    maskedFieldLookup: Set<string>,
  ): boolean {
    const keyLower = key.toLowerCase()
    if (maskedFieldLookup.has(keyLower)) return true

    const masks = this.policy.maskColumns ?? []
    const table = typeof row._table === 'string' ? row._table : ''
    const sourceKey = aliases?.[keyLower] || key
    const qualifiedSource = table ? `${table}.${sourceKey}` : sourceKey

    // Also mask by bare COLUMN NAME (last path segment of any mask rule). This
    // closes the SELECT * / star-projection leak: when the executable rows carry
    // no _table qualifier, a fully-qualified rule like public.customers.address
    // would otherwise never match. For a PII tool, over-masking a configured
    // column name across governed output is the safe direction.
    return masks.some(m =>
      match(m, qualifiedSource) || match(m, sourceKey) || match(m, key) ||
      m.slice(m.lastIndexOf('.') + 1).toLowerCase() === keyLower)
  }

  maskPII(obj: unknown, ctx?: { column?: string }): { masked: unknown, count: number, byClass: Record<string, number> } {
    if (!obj) return { masked: obj, count: 0, byClass: {} };

    // SAYISAL PII (NEO guvenlik taramasi, 2026-07-31 — deneysel dogrulandi).
    // Maskeleme yalnizca string ve object dallarinda calisiyordu; number/bigint
    // hicbir kontrolden gecmeden HAM donuyordu. Olculen sonuc:
    //   tckn_metin "12345678901" -> [MASKED_PII]   ·  tckn_sayi 12345678901 -> SIZDI
    // Turkiye'de TCKN ve telefonun bigint tutulmasi yaygin; bu teorik degil.
    //
    // Sayi metne cevrilip AYNI desenlerden geciriliyor — ayri bir "hangi sayi
    // PII'dir" kural seti tutmak ikinci bir kaynak yaratir ve biri bayatlar.
    // Desen tutmazsa sayi TIPI KORUNARAK aynen doner: id/adet/fiyat/yil bozulmaz.
    // 13–16 hane Luhn tutmuyorsa, veya dizi daha uzunsa (siparis no), icerik
    // tarayici dokunmaz — yarim maske + maskedCount yalanindan daha kotu.
    if (typeof obj === 'number' || typeof obj === 'bigint') {
      const sonuc = this.maskPII(String(obj), ctx);
      return sonuc.count > 0 ? sonuc : { masked: obj, count: 0, byClass: {} };
    }

    if (typeof obj === 'string') {
      if (ctx?.column) {
        const named = maskByColumnName(ctx.column)
        if (named) return { masked: named, count: 1, byClass: {} }
      }
      let count = 0;
      const byClass: Record<string, number> = {};
      // Fail-closed size cap: scanning a 40 KB digit field is O(n²) on the
      // unbounded email regex and blocks the event loop. Skipping the scan
      // would be the attack ("send 100 KB, skip masking"). The whole field
      // is masked instead; maskedCount records that a decision was made.
      if (obj.length > resolveScanCharCap(this.policy.scanCharCap)) {
        return { masked: '[MASKED_PII]', count: 1, byClass: {} }
      }
      // Normalise first (ZWSP/homoglyph/fullwidth/unicode dash). The outgoing
      // string is this form even when nothing is PII — see pii_normalize.ts.
      let masked = normalizePiiText(obj);

      // IBAN BEFORE digit detectors. The card/TCKN/phone regexes otherwise eat
      // the numeric tail and leave `TR00000000000[MASKED_PII]` — which looks
      // like protection and is the worse outcome. Checksum-fail lookalikes
      // are shielded until after those regexes, then restored unmasked.
      const ibanPass = prepareIbanPass(masked)
      masked = ibanPass.text
      count += ibanPass.count

      const emailPass = maskEmails(masked)
      masked = emailPass.text
      count += emailPass.count
      const entityPass = maskEntityEncodedEmails(masked)
      masked = entityPass.text
      count += entityPass.count
      const numPass = maskNumericPii(masked)
      masked = numPass.text
      count += numPass.count

      if (this.policy.detectors?.ip === true) {
        const ipPass = maskIps(masked)
        masked = ipPass.text
        count += ipPass.count
      }
      if (this.policy.detectors?.mrz !== false) {
        const mrzPass = maskMrz(masked)
        masked = mrzPass.text
        count += mrzPass.count
      }

      // Sertleştirme (Codex denetimi 2026-07-06, P1): README "secrets are redacted in the
      // response stream" diyor ama yanıt yolu (maskPII) sadece PII yakalıyordu — API key /
      // token / şifre / bağlantı-dizesi kimliği MODELE ham gidiyordu (ör. api_key sütunu
      // maskColumns'ta değilse). Audit yolu (audit.ts maskArgs) bunu zaten yakalıyordu;
      // aynı dedektörleri yanıt yoluna da taşıdık. Ürünün güvenlik vaadi = bu.
      // sk- ailesi: yeni OpenAI anahtarları sk-proj-... (tire içerir) → tire/alt-çizgiye izin ver.
      // Secrets and labelled names need letters. A 12k-digit order field
      // otherwise still pays for those unicode regexes.
      if (/[A-Za-z]/.test(masked)) {
        const secretRe = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{6,}|sk_test_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g;
        masked = masked.replace(secretRe, () => { count++; return '[MASKED_SECRET]'; });
        masked = masked.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g, (_m, p1, p2) => { count++; return `${p1}[MASKED_SECRET]${p2}`; });
        masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });
        masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });
      }

      // LABELLED NAMES. A person's name is the one identifier this gateway could
      // not see: emails, national ids, phones and cards have shape, names do not.
      // Column policy caught `customer_name`; a name written into a free-text
      // note went to the model verbatim.
      //
      // What this does NOT do, deliberately: detect a bare name in running prose
      // ("Ahmet called yesterday"). That needs NER — a model, a dictionary and a
      // confidence score — and this gateway's whole claim is that its decisions
      // are deterministic and reproducible from the rule alone. Only names the
      // TEXT ITSELF marks as names, via a title or a field label, are masked.
      // The residual gap is documented rather than papered over.
      if (this.policy.maskLabelledNames !== false && /[\p{L}]/u.test(masked)) {
        masked = masked.replace(TITLED_NAME_RE, (_m, title: string) => {
          count++
          return `${title} [MASKED_PII]`
        })
        masked = masked.replace(LABELLED_NAME_RE, (_m, label: string) => {
          count++
          return `${label}: [MASKED_PII]`
        })
      }

      // Sertleştirme (Claude, 2026-07-02): encode(...,'base64') ile kaçırılan PII'yi de yakala.
      // NEO red-team harness bu deliği buldu (pii-base64 BYPASS). Saf base64 bir metin
      // çözülünce e-posta/TCKN içeriyorsa maskele.
      // Length-capped: a 12k-digit field matches `{12,}` and Buffer.from of
      // 12 kB of '1's was the leftover ~80 ms after the email regex was bounded.
      // Encoded TCKN/email/IBAN fit in well under 256 characters.
      const b64candidate = masked.trim();
      if (b64candidate.length <= 256 && /^[A-Za-z0-9+/]{12,}={0,2}$/.test(b64candidate)) {
        try {
          const decoded = Buffer.from(b64candidate, 'base64').toString('utf8');
          if (maskEmails(decoded).count > 0 || maskNumericPii(decoded).count > 0 || maskIbansInText(decoded).count > 0) {
            count++;
            masked = '[MASKED_PII]';
          }
        } catch { /* base64 değil */ }
      }

      masked = ibanPass.restore(masked)

      // Backstop: a leftover country-code prefix glued to a mask is a partial
      // IBAN. Collapse it to a full mask so maskedCount cannot claim protection
      // while the prefix is still in the clear.
      const collapsed = collapsePartialMask(masked)
      if (collapsed !== masked) {
        masked = collapsed
        if (count === 0) count++
      }

      const encoded = maskEmbeddedEncodedPii(masked, (s) => maskIbansInText(s).count > 0)
      masked = encoded.text
      count += encoded.count

      // Operator patterns last: they catch formats the built-ins do not know.
      // Same scanner, same count. Receipt records the rule name, never the pattern.
      if (this.customPatterns.length > 0) {
        const custom = applyCustomPatterns(masked, this.customPatterns, ctx?.column)
        masked = custom.text
        count += custom.count
        mergeByClass(byClass, custom.byClass)
      }

      return { masked, count, byClass };
    }

    if (Array.isArray(obj)) {
      let totalCount = 0;
      const byClass: Record<string, number> = {};
      const maskedArray = obj.map(item => {
        const res = this.maskPII(item, ctx);
        totalCount += res.count;
        mergeByClass(byClass, res.byClass);
        return res.masked;
      });
      return { masked: maskedArray, count: totalCount, byClass };
    }

    if (typeof obj === 'object') {
      let totalCount = 0;
      const byClass: Record<string, number> = {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const childCtx = { column: ctx?.column ? `${ctx.column}.${k}` : k }
        if (typeof v === 'string') {
          const named = maskByColumnName(childCtx.column)
          if (named) {
            out[k] = named
            totalCount++
          } else {
            const res = this.maskPII(v, childCtx);
            out[k] = res.masked;
            totalCount += res.count;
            mergeByClass(byClass, res.byClass);
          }
        } else {
          const res = this.maskPII(v, childCtx);
          out[k] = res.masked;
          totalCount += res.count;
          mergeByClass(byClass, res.byClass);
        }
      }
      return { masked: out, count: totalCount, byClass };
    }

    return { masked: obj, count: 0, byClass: {} };
  }

  private createAnalysisState(): AnalysisState {
    return {
      accessedTables: new Set(),
      accessedFunctions: new Set(),
    }
  }

  private metadataFrom(
    state: AnalysisState,
    opts: {
      rewrittenSql?: string
      appliedRowCap?: number
      maskedFields?: Set<string>
      maskedCount?: number
      byClass?: Record<string, number>
      truncated?: boolean
      denied?: boolean
      denyReason?: string
    } = {}
  ): GovernanceMetadata {
    return {
      accessedTables: [...state.accessedTables].sort(),
      accessedFunctions: [...state.accessedFunctions].sort(),
      rewrittenSql: opts.rewrittenSql,
      appliedRowCap: opts.appliedRowCap,
      maskedFields: [...(opts.maskedFields ?? new Set<string>())].sort(),
      maskedCount: opts.maskedCount ?? 0,
      byClass: opts.byClass && Object.keys(opts.byClass).length > 0 ? opts.byClass : undefined,
      truncated: opts.truncated,
      denied: opts.denied ?? false,
      denyReason: opts.denyReason,
    }
  }

  private metadataFromMetadata(
    metadata: GovernanceMetadata | undefined,
    opts: {
      maskedFields: Set<string>
      maskedCount: number
      byClass?: Record<string, number>
      truncated: boolean
    }
  ): GovernanceMetadata {
    return {
      accessedTables: metadata?.accessedTables ?? [],
      accessedFunctions: metadata?.accessedFunctions ?? [],
      rewrittenSql: metadata?.rewrittenSql,
      appliedRowCap: metadata?.appliedRowCap ?? this.maxRows(),
      maskedFields: [...opts.maskedFields].sort(),
      maskedCount: opts.maskedCount,
      byClass: opts.byClass && Object.keys(opts.byClass).length > 0 ? opts.byClass : undefined,
      truncated: opts.truncated,
      denied: metadata?.denied ?? false,
      denyReason: metadata?.denyReason,
    }
  }

  private deny(state: AnalysisState, reason: string): never {
    throw new PolicyError(reason, this.metadataFrom(state, {
      appliedRowCap: this.maxRows(),
      denied: true,
      denyReason: reason,
    }))
  }

  private isSchemaQualifiedTable(table: string): boolean {
    const parts = table.trim().split('.')
    return parts.length === 2 && parts.every(Boolean)
  }

  private normalizeIdentifier(value: string): string {
    return value.trim().toLowerCase()
  }

  private qualifiedTable(schema: string, table: string): string {
    return `${this.normalizeIdentifier(schema)}.${this.normalizeIdentifier(table)}`
  }

  private analyzeRead(
    statement: Statement | SelectStatement,
    state: AnalysisState,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>> = new Map()
  ): SelectAnalysis {
    if (statement.type === 'with') {
      const scopedCtes = new Set(cteNames)
      const scopedOutputs = new Map(cteOutputs)

      for (const binding of statement.bind) {
        scopedCtes.add(this.normalizeIdentifier(binding.alias.name))
      }

      for (const binding of statement.bind) {
        const analyzed = this.analyzeRead(binding.statement, state, scopedCtes, scopedOutputs)
        scopedOutputs.set(this.normalizeIdentifier(binding.alias.name), analyzed.maskedOutputs)
      }

      return this.analyzeRead(statement.in, state, scopedCtes, scopedOutputs)
    }

    if (statement.type === 'with recursive') {
      const scopedCtes = new Set(cteNames)
      const cteName = this.normalizeIdentifier(statement.alias.name)
      scopedCtes.add(cteName)
      const scopedOutputs = new Map(cteOutputs)
      const analyzed = this.analyzeRead(statement.bind, state, scopedCtes, scopedOutputs)
      scopedOutputs.set(cteName, analyzed.maskedOutputs)
      return this.analyzeRead(statement.in, state, scopedCtes, scopedOutputs)
    }

    if (statement.type === 'select') {
      return this.analyzeSelect(statement, state, cteNames, cteOutputs)
    }

    if (statement.type === 'union' || statement.type === 'union all') {
      const left = this.analyzeRead(statement.left, state, cteNames, cteOutputs)
      const right = this.analyzeRead(statement.right, state, cteNames, cteOutputs)
      return {
        maskedOutputs: new Set([...left.maskedOutputs, ...right.maskedOutputs]),
        aliases: { ...left.aliases, ...right.aliases },
      }
    }

    if (statement.type === 'values') {
      return { maskedOutputs: new Set(), aliases: {} }
    }

    this.deny(state, 'Only read-only SELECT/WITH queries are permitted.')
  }

  private analyzeSelect(
    statement: SelectFromStatement,
    state: AnalysisState,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>>
  ): SelectAnalysis {
    const scope: SelectScope = { sources: new Map() }
    const maskedOutputs = new Set<string>()
    const aliases: Record<string, string> = {}

    for (const from of statement.from ?? []) {
      this.collectFrom(from, state, scope, cteNames, cteOutputs)
    }

    statement.where && this.collectExpr(statement.where, state, scope, cteNames, cteOutputs)
    statement.having && this.collectExpr(statement.having, state, scope, cteNames, cteOutputs)
    for (const expr of statement.groupBy ?? []) this.collectExpr(expr, state, scope, cteNames, cteOutputs)
    for (const order of statement.orderBy ?? []) this.collectOrderBy(order, state, scope, cteNames, cteOutputs)

    const columns = statement.columns ?? []
    columns.forEach((column, index) => {
      this.collectExpr(column.expr, state, scope, cteNames, cteOutputs)

      if (column.alias && column.expr.type === 'ref' && column.expr.name !== '*') {
        aliases[this.normalizeIdentifier(column.alias.name)] = this.normalizeIdentifier(column.expr.name)
      }

      if (!this.expressionReferencesMasked(column.expr, scope, cteNames, cteOutputs)) return

      const output = this.outputNamesForColumn(column, index, scope)
      if (!output.reliable) {
        this.deny(state, 'Query output expression references a masked column but has no reliable output name to redact.')
      }
      for (const name of output.names) maskedOutputs.add(name)
    })

    return { maskedOutputs, aliases }
  }

  private collectFrom(
    from: From,
    state: AnalysisState,
    scope: SelectScope,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>>
  ): void {
    if (from.type === 'table') {
      const tableName = this.normalizeIdentifier(from.name.name)
      const alias = from.name.alias ? this.normalizeIdentifier(from.name.alias) : tableName

      if (!from.name.schema && cteNames.has(tableName)) {
        this.addSource(scope, alias, {
          kind: 'derived',
          maskedColumns: cteOutputs.get(tableName) ?? new Set(),
        })
        if (from.join?.on) this.collectExpr(from.join.on, state, scope, cteNames, cteOutputs)
        return
      }

      if (!from.name.schema) {
        this.deny(state, `Unqualified table '${from.name.name}' is not permitted; use schema.table.`)
      }

      // The parser folds unquoted identifiers to lowercase (PostgreSQL semantics), so an
      // uppercase character here can only come from a quoted identifier — and Postgres
      // treats `public."Customers"` as a DIFFERENT table than public.customers. Folding it
      // for policy matching would let it ride an allow-list entry it doesn't belong to.
      if (from.name.name !== from.name.name.toLowerCase() || from.name.schema !== from.name.schema.toLowerCase()) {
        this.deny(state, `Quoted mixed-case identifier '${from.name.schema}.${from.name.name}' is not permitted; policy matching is lowercase-only.`)
      }

      const qualified = this.qualifiedTable(from.name.schema, from.name.name)
      state.accessedTables.add(qualified)
      this.enforceTableAccess(qualified, state)
      this.addSource(scope, alias, {
        kind: 'table',
        schema: this.normalizeIdentifier(from.name.schema),
        table: tableName,
      })

      if (from.join?.on) this.collectExpr(from.join.on, state, scope, cteNames, cteOutputs)
      return
    }

    if (from.type === 'statement') {
      const analyzed = this.analyzeRead(from.statement, state, cteNames, cteOutputs)
      this.addSource(scope, this.normalizeIdentifier(from.alias), {
        kind: 'derived',
        maskedColumns: analyzed.maskedOutputs,
      })
      if (from.join?.on) this.collectExpr(from.join.on, state, scope, cteNames, cteOutputs)
      return
    }

    if (from.type === 'call') {
      this.inspectFunction(from, state)
      for (const arg of from.args) this.collectExpr(arg, state, scope, cteNames, cteOutputs)
      for (const order of from.orderBy ?? []) this.collectOrderBy(order, state, scope, cteNames, cteOutputs)
      if (from.filter) this.collectExpr(from.filter, state, scope, cteNames, cteOutputs)
      if (from.withinGroup) this.collectOrderBy(from.withinGroup, state, scope, cteNames, cteOutputs)
      if (from.over?.orderBy) for (const order of from.over.orderBy) this.collectOrderBy(order, state, scope, cteNames, cteOutputs)
      if (from.over?.partitionBy) for (const expr of from.over.partitionBy) this.collectExpr(expr, state, scope, cteNames, cteOutputs)
      if (from.join?.on) this.collectExpr(from.join.on, state, scope, cteNames, cteOutputs)
    }
  }

  private addSource(scope: SelectScope, alias: string, source: Source): void {
    scope.sources.set(alias, source)
  }

  private enforceTableAccess(qualified: string, state: AnalysisState): void {
    if (qualified.startsWith('pg_catalog.') || qualified.startsWith('information_schema.') || qualified.startsWith('public.pg_')) {
      this.deny(state, `Access to system catalog '${qualified}' is forbidden.`)
    }
    if (!this.allowsTable(qualified)) {
      this.deny(state, `Access to table '${qualified}' is not permitted by policy.`)
    }
  }

  private collectOrderBy(
    order: OrderByStatement,
    state: AnalysisState,
    scope: SelectScope,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>>
  ): void {
    this.collectExpr(order.by, state, scope, cteNames, cteOutputs)
  }

  private collectExpr(
    expr: Expr,
    state: AnalysisState,
    scope: SelectScope,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>>
  ): void {
    switch (expr.type) {
      case 'call':
        this.inspectFunction(expr, state)
        for (const arg of expr.args) this.collectExpr(arg, state, scope, cteNames, cteOutputs)
        for (const order of expr.orderBy ?? []) this.collectOrderBy(order, state, scope, cteNames, cteOutputs)
        if (expr.filter) this.collectExpr(expr.filter, state, scope, cteNames, cteOutputs)
        if (expr.withinGroup) this.collectOrderBy(expr.withinGroup, state, scope, cteNames, cteOutputs)
        if (expr.over?.orderBy) for (const order of expr.over.orderBy) this.collectOrderBy(order, state, scope, cteNames, cteOutputs)
        if (expr.over?.partitionBy) for (const item of expr.over.partitionBy) this.collectExpr(item, state, scope, cteNames, cteOutputs)
        return
      case 'cast':
        this.collectExpr(expr.operand, state, scope, cteNames, cteOutputs)
        return
      case 'binary':
        this.collectExpr(expr.left, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.right, state, scope, cteNames, cteOutputs)
        return
      case 'unary':
        this.collectExpr(expr.operand, state, scope, cteNames, cteOutputs)
        return
      case 'ternary':
        this.collectExpr(expr.value, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.lo, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.hi, state, scope, cteNames, cteOutputs)
        return
      case 'case':
        if (expr.value) this.collectExpr(expr.value, state, scope, cteNames, cteOutputs)
        for (const when of expr.whens) {
          this.collectExpr(when.when, state, scope, cteNames, cteOutputs)
          this.collectExpr(when.value, state, scope, cteNames, cteOutputs)
        }
        if (expr.else) this.collectExpr(expr.else, state, scope, cteNames, cteOutputs)
        return
      case 'list':
      case 'array':
        for (const item of expr.expressions) this.collectExpr(item, state, scope, cteNames, cteOutputs)
        return
      case 'array select':
        this.analyzeRead(expr.select, state, cteNames, cteOutputs)
        return
      case 'member':
        this.collectExpr(expr.operand, state, scope, cteNames, cteOutputs)
        return
      case 'extract':
        this.collectExpr(expr.from, state, scope, cteNames, cteOutputs)
        return
      case 'overlay':
        this.collectExpr(expr.value, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.placing, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.from, state, scope, cteNames, cteOutputs)
        if (expr.for) this.collectExpr(expr.for, state, scope, cteNames, cteOutputs)
        return
      case 'substring':
        this.collectExpr(expr.value, state, scope, cteNames, cteOutputs)
        if (expr.from) this.collectExpr(expr.from, state, scope, cteNames, cteOutputs)
        if (expr.for) this.collectExpr(expr.for, state, scope, cteNames, cteOutputs)
        return
      case 'arrayIndex':
        this.collectExpr(expr.array, state, scope, cteNames, cteOutputs)
        this.collectExpr(expr.index, state, scope, cteNames, cteOutputs)
        return
      case 'select':
      case 'with':
      case 'with recursive':
      case 'union':
      case 'union all':
      case 'values':
        this.analyzeRead(expr, state, cteNames, cteOutputs)
        return
      default:
        return
    }
  }

  private inspectFunction(call: ExprCall, state: AnalysisState): void {
    const fn = this.functionId(call.function)
    state.accessedFunctions.add(fn)

    const baseName = this.normalizeIdentifier(call.function.name)
    if (isBlockedDumpFunction(baseName)) {
      this.deny(state, `High-risk aggregate/serialization function '${fn}' is not permitted by policy.`)
    }

    const schema = call.function.schema ? this.normalizeIdentifier(call.function.schema) : undefined
    if (!isSafeBuiltinFunction(baseName, schema)) {
      this.deny(state, `Function '${fn}' is not permitted by policy.`)
    }
  }

  private functionId(fn: QName): string {
    return fn.schema ? `${this.normalizeIdentifier(fn.schema)}.${this.normalizeIdentifier(fn.name)}` : this.normalizeIdentifier(fn.name)
  }

  private expressionReferencesMasked(
    expr: Expr,
    scope: SelectScope,
    cteNames: Set<string>,
    cteOutputs: Map<string, Set<string>>
  ): boolean {
    switch (expr.type) {
      case 'ref':
        return this.refReferencesMasked(expr, scope)
      case 'call':
        return expr.args.some(arg => this.expressionReferencesMasked(arg, scope, cteNames, cteOutputs))
          || (expr.filter ? this.expressionReferencesMasked(expr.filter, scope, cteNames, cteOutputs) : false)
          || (expr.orderBy ?? []).some(order => this.expressionReferencesMasked(order.by, scope, cteNames, cteOutputs))
          || (expr.withinGroup ? this.expressionReferencesMasked(expr.withinGroup.by, scope, cteNames, cteOutputs) : false)
          || (expr.over?.orderBy ?? []).some(order => this.expressionReferencesMasked(order.by, scope, cteNames, cteOutputs))
          || (expr.over?.partitionBy ?? []).some(item => this.expressionReferencesMasked(item, scope, cteNames, cteOutputs))
      case 'cast':
        return this.expressionReferencesMasked(expr.operand, scope, cteNames, cteOutputs)
      case 'binary':
        return this.expressionReferencesMasked(expr.left, scope, cteNames, cteOutputs) || this.expressionReferencesMasked(expr.right, scope, cteNames, cteOutputs)
      case 'unary':
        return this.expressionReferencesMasked(expr.operand, scope, cteNames, cteOutputs)
      case 'ternary':
        return this.expressionReferencesMasked(expr.value, scope, cteNames, cteOutputs)
          || this.expressionReferencesMasked(expr.lo, scope, cteNames, cteOutputs)
          || this.expressionReferencesMasked(expr.hi, scope, cteNames, cteOutputs)
      case 'case':
        return (expr.value ? this.expressionReferencesMasked(expr.value, scope, cteNames, cteOutputs) : false)
          || expr.whens.some(when => this.expressionReferencesMasked(when.when, scope, cteNames, cteOutputs) || this.expressionReferencesMasked(when.value, scope, cteNames, cteOutputs))
          || (expr.else ? this.expressionReferencesMasked(expr.else, scope, cteNames, cteOutputs) : false)
      case 'list':
      case 'array':
        return expr.expressions.some(item => this.expressionReferencesMasked(item, scope, cteNames, cteOutputs))
      case 'array select':
        return this.analyzeRead(expr.select, this.createAnalysisState(), cteNames, cteOutputs).maskedOutputs.size > 0
      case 'member':
        return this.expressionReferencesMasked(expr.operand, scope, cteNames, cteOutputs)
      case 'extract':
        return this.expressionReferencesMasked(expr.from, scope, cteNames, cteOutputs)
      case 'overlay':
        return this.expressionReferencesMasked(expr.value, scope, cteNames, cteOutputs)
          || this.expressionReferencesMasked(expr.placing, scope, cteNames, cteOutputs)
          || this.expressionReferencesMasked(expr.from, scope, cteNames, cteOutputs)
          || (expr.for ? this.expressionReferencesMasked(expr.for, scope, cteNames, cteOutputs) : false)
      case 'substring':
        return this.expressionReferencesMasked(expr.value, scope, cteNames, cteOutputs)
          || (expr.from ? this.expressionReferencesMasked(expr.from, scope, cteNames, cteOutputs) : false)
          || (expr.for ? this.expressionReferencesMasked(expr.for, scope, cteNames, cteOutputs) : false)
      case 'arrayIndex':
        return this.expressionReferencesMasked(expr.array, scope, cteNames, cteOutputs) || this.expressionReferencesMasked(expr.index, scope, cteNames, cteOutputs)
      case 'select':
      case 'with':
      case 'with recursive':
      case 'union':
      case 'union all':
      case 'values':
        return this.analyzeRead(expr, this.createAnalysisState(), cteNames, cteOutputs).maskedOutputs.size > 0
      default:
        return false
    }
  }

  private refReferencesMasked(ref: ExprRef, scope: SelectScope): boolean {
    const column = this.normalizeIdentifier(ref.name)
    if (column === '*') {
      return [...scope.sources.values()].some(source => (source.maskedColumns?.size ?? 0) > 0)
    }

    if (ref.table?.schema) {
      return this.matchesMaskedColumn(this.normalizeIdentifier(ref.table.schema), this.normalizeIdentifier(ref.table.name), column)
    }

    if (ref.table?.name) {
      const source = scope.sources.get(this.normalizeIdentifier(ref.table.name))
      if (source?.kind === 'derived') return source.maskedColumns?.has(column) ?? false
      if (source?.kind === 'table' && source.schema && source.table) {
        return this.matchesMaskedColumn(source.schema, source.table, column)
      }
      return this.matchesMaskedColumn(undefined, this.normalizeIdentifier(ref.table.name), column)
    }

    for (const source of scope.sources.values()) {
      if (source.kind === 'derived' && source.maskedColumns?.has(column)) return true
      if (source.kind === 'table' && source.schema && source.table && this.matchesMaskedColumn(source.schema, source.table, column)) return true
    }

    return this.matchesMaskedColumn(undefined, undefined, column)
  }

  private matchesMaskedColumn(schema: string | undefined, table: string | undefined, column: string): boolean {
    const masks = this.policy.maskColumns ?? []
    const candidates = new Set<string>([column])

    if (table) candidates.add(`${table}.${column}`)
    if (schema && table) candidates.add(`${schema}.${table}.${column}`)
    if (schema) candidates.add(`${schema}.${column}`)

    return masks.some(mask => [...candidates].some(candidate => match(mask, candidate)))
  }

  private outputNamesForColumn(column: SelectedColumn, index: number, scope: SelectScope): { names: string[]; reliable: boolean } {
    if (column.alias) return { names: [column.alias.name], reliable: true }

    const expr = column.expr
    if (expr.type === 'ref') {
      if (expr.name === '*') {
        const names = [...scope.sources.values()].flatMap(source => [...(source.maskedColumns ?? new Set<string>())])
        return { names, reliable: names.length > 0 }
      }
      return { names: [expr.name], reliable: true }
    }

    if (expr.type === 'cast' && expr.operand.type === 'ref' && expr.operand.name !== '*') {
      return { names: [expr.operand.name], reliable: true }
    }

    if (expr.type === 'call') {
      return { names: [expr.function.name], reliable: false }
    }

    return { names: [`column_${index + 1}`], reliable: false }
  }

  private applyRowCap(statement: Statement | SelectStatement): void {
    applyPostgresRowCap(statement, this.maxRows())
  }

  private limitTarget(statement: Statement | SelectStatement): SelectFromStatement | undefined {
    return postgresLimitTarget(statement)
  }
}

export class ApiGovernance {
  private policy: GovernancePolicy

  constructor(policy: GovernancePolicy = {}) {
    this.policy = policy
  }

  allowsTool(toolName: string): boolean {
    const { allowTools, denyTools } = this.policy
    if (denyTools?.some(p => match(p, toolName))) return false
    if (allowTools && allowTools.length > 0) return allowTools.some(p => match(p, toolName))
    return true
  }

  redactResponse(data: any): any {
    if (!data) return data;
    const max = this.policy.maxRows ?? 100;
    if (Array.isArray(data)) {
      data = data.slice(0, max).map(item => this.maskPii(item));
    } else {
      data = this.maskPii(data);
    }
    return data;
  }

  private maskPii(obj: any): any {
    if (!obj) return obj;
    if (typeof obj === 'string') return this.applyRegexMasks(obj);
    if (Array.isArray(obj)) return obj.map(item => this.maskPii(item));

    if (typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          const lowerKey = k.toLowerCase();
          if (lowerKey.includes('email') || lowerKey.includes('phone') || lowerKey.includes('tckn') || lowerKey.includes('card') || lowerKey.includes('iban')) {
            out[k] = '[MASKED_PII]';
          } else {
            out[k] = this.applyRegexMasks(v);
          }
        } else {
          out[k] = this.maskPii(v);
        }
      }
      return out;
    }
    return obj;
  }

  private applyRegexMasks(text: string): string {
    // Same scanner as Governance.maskPII — a second regex list here used to
    // skip normalisation and wrapped-token detection.
    return new Governance(this.policy).maskPII(text).masked as string
  }
}
