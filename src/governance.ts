import type { GovernancePolicy, SchemaTable, QueryResult } from './types.js'
import { parse, toSql } from 'pgsql-ast-parser'
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

export interface GovernanceMetadata {
  accessedTables: string[]
  accessedFunctions: string[]
  rewrittenSql?: string
  appliedRowCap?: number
  maskedFields: string[]
  maskedCount: number
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

const WRITE_TOKENS = [
  'DROP ', 'TRUNCATE ', 'DELETE ', 'UPDATE ', 'INSERT ', 'ALTER ', 'CREATE ',
  'GRANT ', 'REVOKE ', 'MERGE ', 'COPY ', 'CALL ', 'DO ', 'VACUUM ',
]

const SAFE_BUILTIN_FUNCTIONS = new Set([
  'abs',
  'avg',
  'btrim',
  'ceil',
  'ceiling',
  'char_length',
  'coalesce',
  'concat',
  'concat_ws',
  'convert_to',
  'count',
  'encode',
  'floor',
  'greatest',
  'least',
  'length',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'octet_length',
  'regexp_replace',
  'regexp_split_to_array',
  'replace',
  'round',
  'rtrim',
  'split_part',
  'sum',
  'trim',
  'upper',
])

const BLOCKED_DUMP_FUNCTIONS = new Set([
  'array_agg',
  'json_agg',
  'jsonb_agg',
  'row_to_json',
  'string_agg',
])

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

export class Governance {
  private policy: GovernancePolicy

  constructor(policy: GovernancePolicy = {}) {
    this.policy = policy
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

  allowsConnector(connectorName: string): boolean {
    const { allowConnectors, denyConnectors } = this.policy
    if (denyConnectors?.some(p => match(p, connectorName))) return false
    if (allowConnectors && allowConnectors.length > 0) {
      return allowConnectors.some(p => match(p, connectorName))
    }
    return true
  }

  guardQuery(sql: string): GuardedQuery {
    const emptyState = this.createAnalysisState()
    const norm = ` ${sql.trim().toUpperCase().replace(/\s+/g, ' ')} `
    const head = norm.trimStart()
    if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
      this.deny(emptyState, 'Only read-only SELECT/WITH queries are permitted.')
    }
    
    for (const tok of WRITE_TOKENS) {
      const regex = new RegExp(`\\b${tok.trim()}\\b`)
      if (regex.test(norm)) this.deny(emptyState, `Blocked write operation: ${tok.trim()}`)
    }

    // Row-locking clauses acquire locks (a side effect) — refuse them on governed reads.
    if (/\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/.test(norm)) {
      this.deny(emptyState, 'Row-locking clauses (FOR UPDATE/SHARE) are not permitted.')
    }

    let ast: Statement[]
    try {
      ast = parse(sql)
    } catch (err) {
      this.deny(emptyState, `Failed to parse SQL: ${(err as Error).message}`)
    }

    if (ast.length > 1) {
      this.deny(emptyState, 'Multiple statements are not permitted.')
    }

    const state = this.createAnalysisState()
    const output = this.analyzeRead(ast[0], state, new Set())

    this.applyRowCap(ast[0])
    const rewrittenSql = toSql.statement(ast[0])
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
    const masks = this.policy.maskColumns ?? []
    const maskedFieldLookup = new Set((metadata?.maskedFields ?? []).map(f => f.toLowerCase()))
    const maskedFields = new Set(metadata?.maskedFields ?? [])
    let maskedCount = 0

    const rows = result.rows.map(row => {
      const out: Record<string, unknown> = { ...row }
      for (const key of Object.keys(out)) {
        const table = typeof out._table === 'string' ? out._table : ''
        const sourceKey = aliases?.[key.toLowerCase()] || key
        const keyLower = key.toLowerCase()
        const qualifiedSource = table ? `${table}.${sourceKey}` : sourceKey
        
        // Also mask by bare COLUMN NAME (last path segment of any mask rule). This
        // closes the SELECT * / star-projection leak: when the executable rows carry
        // no _table qualifier, a fully-qualified rule like public.customers.address
        // would otherwise never match. For a PII tool, over-masking a configured
        // column name across governed output is the safe direction.
        const maskColMatch = masks.some(m =>
          match(m, qualifiedSource) || match(m, sourceKey) || match(m, key) ||
          m.slice(m.lastIndexOf('.') + 1).toLowerCase() === keyLower)
        if (maskedFieldLookup.has(keyLower) || maskColMatch) {
          out[key] = '[MASKED_PII]'
          maskedFields.add(key)
          maskedCount++
          continue
        }
        
        const scanRes = this.maskPII(out[key])
        out[key] = scanRes.masked
        if (scanRes.count > 0) {
          maskedFields.add(key)
          maskedCount += scanRes.count
        }
      }
      return out
    })

    const governance = this.metadataFromMetadata(metadata, {
      maskedFields,
      maskedCount,
      truncated: result.rowCount > this.maxRows(),
    })

    return { ...result, rows, governance }
  }

  maskPII(obj: unknown): { masked: unknown, count: number } {
    if (!obj) return { masked: obj, count: 0 };

    if (typeof obj === 'string') {
      let count = 0;
      let masked = obj;
      
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const tcknRegex = /\b[1-9][0-9]{10}\b/g;
      const phoneRegex = /(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g;
      const cardRegex = /\b(?:\d[ -]*?){13,16}\b/g;

      masked = masked.replace(emailRegex, () => { count++; return '[MASKED_PII]'; });
      masked = masked.replace(tcknRegex, () => { count++; return '[MASKED_PII]'; });
      masked = masked.replace(phoneRegex, () => { count++; return '[MASKED_PII]'; });
      masked = masked.replace(cardRegex, () => { count++; return '[MASKED_PII]'; });

      // Sertleştirme (Codex denetimi 2026-07-06, P1): README "secrets are redacted in the
      // response stream" diyor ama yanıt yolu (maskPII) sadece PII yakalıyordu — API key /
      // token / şifre / bağlantı-dizesi kimliği MODELE ham gidiyordu (ör. api_key sütunu
      // maskColumns'ta değilse). Audit yolu (audit.ts maskArgs) bunu zaten yakalıyordu;
      // aynı dedektörleri yanıt yoluna da taşıdık. Ürünün güvenlik vaadi = bu.
      // sk- ailesi: yeni OpenAI anahtarları sk-proj-... (tire içerir) → tire/alt-çizgiye izin ver.
      const secretRe = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{6,}|sk_test_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g;
      masked = masked.replace(secretRe, () => { count++; return '[MASKED_SECRET]'; });
      masked = masked.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g, (_m, p1, p2) => { count++; return `${p1}[MASKED_SECRET]${p2}`; });
      masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });
      masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });

      // Sertleştirme (Claude, 2026-07-02): encode(...,'base64') ile kaçırılan PII'yi de yakala.
      // NEO red-team harness bu deliği buldu (pii-base64 BYPASS). Saf base64 bir metin
      // çözülünce e-posta/TCKN içeriyorsa maskele.
      const b64candidate = masked.trim();
      if (/^[A-Za-z0-9+/]{12,}={0,2}$/.test(b64candidate)) {
        try {
          const decoded = Buffer.from(b64candidate, 'base64').toString('utf8');
          if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(decoded) || /\b[1-9][0-9]{10}\b/.test(decoded)) {
            count++;
            masked = '[MASKED_PII]';
          }
        } catch { /* base64 değil */ }
      }

      return { masked, count };
    }

    if (Array.isArray(obj)) {
      let totalCount = 0;
      const maskedArray = obj.map(item => {
        const res = this.maskPII(item);
        totalCount += res.count;
        return res.masked;
      });
      return { masked: maskedArray, count: totalCount };
    }

    if (typeof obj === 'object') {
      let totalCount = 0;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          const lowerKey = k.toLowerCase();
          if (lowerKey.includes('email') || lowerKey.includes('phone') || lowerKey.includes('tckn') || lowerKey.includes('card')) {
            out[k] = '[MASKED_PII]';
            totalCount++;
          } else if (/secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|\bkey\b|credential/.test(lowerKey)) {
            // Sütun ADI sır ima ediyorsa (api_key, secret, token, password) değeri her hâlükârda maskele.
            out[k] = '[MASKED_SECRET]';
            totalCount++;
          } else {
            const res = this.maskPII(v);
            out[k] = res.masked;
            totalCount += res.count;
          }
        } else {
          const res = this.maskPII(v);
          out[k] = res.masked;
          totalCount += res.count;
        }
      }
      return { masked: out, count: totalCount };
    }

    return { masked: obj, count: 0 };
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
    if (BLOCKED_DUMP_FUNCTIONS.has(baseName)) {
      this.deny(state, `High-risk aggregate/serialization function '${fn}' is not permitted by policy.`)
    }

    const schema = call.function.schema ? this.normalizeIdentifier(call.function.schema) : undefined
    const isSafeBuiltin = SAFE_BUILTIN_FUNCTIONS.has(baseName) && (!schema || schema === 'pg_catalog')
    if (!isSafeBuiltin) {
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
    const target = this.limitTarget(statement)
    if (!target) return

    const cap = this.maxRows()
    const existing = target.limit?.limit as { type?: string; value?: number } | undefined
    // Never RAISE a limit the caller already set below the cap — a request for
    // 1 row must not become 50. Only clamp down; preserve any OFFSET.
    if (existing && existing.type === 'integer' && typeof existing.value === 'number' && existing.value <= cap) {
      return
    }
    target.limit = {
      ...(target.limit ?? {}),
      limit: { type: 'integer', value: cap },
    }
  }

  private limitTarget(statement: Statement | SelectStatement): SelectFromStatement | undefined {
    if (statement.type === 'select') return statement
    if (statement.type === 'with' || statement.type === 'with recursive') return this.limitTarget(statement.in)
    return undefined
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
          if (lowerKey.includes('email') || lowerKey.includes('phone') || lowerKey.includes('tckn') || lowerKey.includes('card')) {
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
    let masked = text;
    masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[MASKED_PII]');
    masked = masked.replace(/\b[1-9][0-9]{10}\b/g, '[MASKED_PII]');
    masked = masked.replace(/(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g, '[MASKED_PII]');
    masked = masked.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[MASKED_PII]');
    return masked;
  }
}
