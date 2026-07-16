export interface ConariumConfig {
  connectors: ConnectorConfig[]
  serverName?: string
  serverVersion?: string
  /** Identity of the consumer (team / editor / user) for audit attribution. */
  consumer?: string
  /** Access policy enforced on every connector call. */
  policy?: GovernancePolicy
  /** Audit configuration. */
  audit?: AuditConfig
}

export interface GovernancePolicy {
  /** Allow-list of schema-qualified tables (glob: "billing.*", "*"). Empty = allow all not denied. */
  allowTables?: string[]
  /** Deny-list of schema-qualified tables; takes precedence over allow. */
  denyTables?: string[]
  /** Columns to mask before data leaves the boundary ("customers.email", "*.tckn"). */
  maskColumns?: string[]
  /** Hard cap on rows returned to the AI assistant (default 100). */
  maxRows?: number
  /** Allowed API tools (e.g. "addPet", "getUser*"). */
  allowTools?: string[]
  /** Denied API tools. */
  denyTools?: string[]
  /** Allowed connector names (glob). Empty = allow all not denied. */
  allowConnectors?: string[]
  /** Denied connector names (glob); takes precedence over allow. */
  denyConnectors?: string[]
}

export interface AuditConfig {
  /** Append-only JSONL file path. If unset, audit goes to stderr only. */
  sink?: string
  failClosed?: boolean
}

export interface ConnectorConfig {
  type: 'postgres' | 'supabase' | 'supabase-rest' | 'openapi' | 'files' | 'docs' | 'slack' | 'jira'
  name: string
  description: string
  config: Record<string, string>
}

export interface SchemaTable {
  name: string
  schema: string
  columns: SchemaColumn[]
  rowCount?: number
  description?: string
}

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  isPrimary: boolean
  isForeign: boolean
  references?: string
  description?: string
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
  fields: string[]
  sql?: string
}

export interface ConnectorCapabilities {
  canQuery: boolean
  canListSchema: boolean
  canDescribeTable: boolean
  canSearch: boolean
}

export interface Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTables(): Promise<SchemaTable[]>
  describeTable(table: string): Promise<SchemaTable>
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  search(query: string, tables?: string[]): Promise<QueryResult>
}
