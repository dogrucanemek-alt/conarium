/**
 * Supabase PostgREST connector (C1).
 * Codes canlı SQL PC'den kapalı olduğunda ZION aynasına (Codes sync) güvenli RO erişim.
 * Ham SQL → yalnızca basit SELECT ... FROM schema.table [LIMIT n] kabul edilir.
 */
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorConfig,
  QueryResult,
  SchemaTable,
} from '../types.js'
import fetch from 'node-fetch'

const WRITE = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER|CREATE|GRANT|REVOKE|MERGE|EXEC|EXECUTE|CALL)\b/i

export class SupabaseRestConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities = {
    canQuery: true,
    canListSchema: true,
    canDescribeTable: true,
    canSearch: false,
  }

  private baseUrl: string
  private apiKey: string
  private anonKey: string
  private schema: string
  private allow: Set<string>

  /** Configured Postgres schema — callers must qualify tables with this, never a hard-coded name. */
  get schemaName(): string {
    return this.schema
  }

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'Supabase PostgREST (ZION RO mirror)'
    this.baseUrl = (config.config.url || process.env.CONARIUM_SUPABASE_URL || '').replace(/\/$/, '')
    this.apiKey = config.config.key || process.env.CONARIUM_SUPABASE_KEY || ''
    // Kong gateway'i apikey basliginda BILINEN bir anahtar ister (anon yeter);
    // kisitli-rol JWT'si yalniz Authorization: Bearer'da rol secer. Ayri verilmezse eski davranis.
    this.anonKey = config.config.anonKey || process.env.CONARIUM_SUPABASE_ANON || this.apiKey
    this.schema = config.config.schema || 'zion'
    const raw = config.config.allowTables || ''
    this.allow = new Set(
      raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => (s.includes('.') ? s.split('.').pop()! : s).toLowerCase())
    )
  }

  async connect(): Promise<void> {
    if (!this.baseUrl) throw new Error(`${this.name}: CONARIUM_SUPABASE_URL / config.url required`)
    if (!this.apiKey) throw new Error(`${this.name}: CONARIUM_SUPABASE_KEY / config.key required`)
    // Saglik kontrolu: OpenAPI koku Kong'da yalniz service_role'a acik — kisitli rol JWT'si
    // orada hep 401 yer. Allowlist varsa ilk tabloya limit=0 sorgusu at (veri donmez).
    const first = [...this.allow].sort()[0]
    const url = first
      ? `${this.baseUrl}/rest/v1/${encodeURIComponent(first)}?select=*&limit=0`
      : `${this.baseUrl}/rest/v1/`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok && res.status !== 200) {
      // 401/403 = bad key / yetkisiz rol
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${this.name}: Supabase REST auth failed (${res.status})`)
      }
    }
  }

  async disconnect(): Promise<void> {}

  async listTables(): Promise<SchemaTable[]> {
    const names = [...this.allow].sort()
    return names.map(name => ({
      name,
      schema: this.schema,
      columns: [],
      description: `${this.schema}.${name}`,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const name = this.normalizeTable(table)
    this.assertAllowed(name)
    // Probe one row for field names
    const url = `${this.baseUrl}/rest/v1/${encodeURIComponent(name)}?select=*&limit=1`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      throw new Error(`${this.name}: describe ${this.schema}.${name} failed: HTTP ${res.status}`)
    }
    const rows = (await res.json()) as Record<string, unknown>[]
    const fields = rows[0] ? Object.keys(rows[0]) : []
    return {
      name,
      schema: this.schema,
      columns: fields.map(f => ({
        name: f,
        type: 'unknown',
        nullable: true,
        isPrimary: false,
        isForeign: false,
      })),
      description: `${this.schema}.${name}`,
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const parsed = this.parseSimpleSelect(sql)
    this.assertAllowed(parsed.table)
    const select = parsed.columns.join(',')
    const lim = parsed.limit
    const url =
      `${this.baseUrl}/rest/v1/${encodeURIComponent(parsed.table)}` +
      `?select=${encodeURIComponent(select)}&limit=${lim}`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${this.name}: query failed HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    const rows = (await res.json()) as Record<string, unknown>[]
    const fields = rows[0] ? Object.keys(rows[0]) : parsed.columns[0] === '*' ? [] : parsed.columns
    return { rows, rowCount: rows.length, fields, sql }
  }

  async search(): Promise<QueryResult> {
    throw new Error('search not supported on supabase-rest; use query with SELECT')
  }

  /** Exported for unit tests */
  parseSimpleSelect(sql: string): { table: string; columns: string[]; limit: number } {
    const norm = sql.trim().replace(/\s+/g, ' ')
    if (WRITE.test(norm)) throw new Error('Write/DDL tokens are not permitted')
    if (!/^SELECT\b/i.test(norm)) throw new Error('Only SELECT is permitted on supabase-rest')
    if (norm.includes(';')) throw new Error('Multiple statements are not permitted')

    const m = norm.match(
      /^SELECT\s+([\w\s*,.]+?)\s+FROM\s+([\w.]+)(?:\s+LIMIT\s+(\d+))?\s*$/i
    )
    if (!m) {
      throw new Error(
        'supabase-rest only allows: SELECT col|* FROM schema.table [LIMIT n] (no WHERE/JOIN yet)'
      )
    }
    const columns = m[1].split(',').map(c => c.trim()).filter(Boolean)
    const table = this.normalizeTable(m[2])
    const limit = Math.min(Math.max(parseInt(m[3] || '20', 10) || 20, 1), 100)
    return { table, columns: columns.length ? columns : ['*'], limit }
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.apiKey}`,
      'Accept-Profile': this.schema,
      'Content-Profile': this.schema,
      Prefer: 'count=exact',
    }
  }

  private normalizeTable(table: string): string {
    const t = table.trim().replace(/["`]/g, '')
    if (t.includes('.')) {
      const [schema, name] = t.split('.', 2)
      if (schema.toLowerCase() !== this.schema.toLowerCase()) {
        throw new Error(`Only schema '${this.schema}' is permitted (got ${schema})`)
      }
      return name.toLowerCase()
    }
    return t.toLowerCase()
  }

  private assertAllowed(table: string): void {
    if (this.allow.size > 0 && !this.allow.has(table.toLowerCase())) {
      throw new Error(`Table '${this.schema}.${table}' is not on connector allowlist`)
    }
  }
}
