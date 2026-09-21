/**
 * In-memory sample rows for `conarium --demo`.
 * Not a database. Masking, row caps, and refusals run in the existing gate
 * after SQL has already passed governance — this connector only resolves
 * which sample table was asked for.
 */
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorConfig,
  QueryResult,
  SchemaColumn,
  SchemaTable,
} from '../types.js'

export const DEMO_UNSUPPORTED_SQL =
  'demo connector answers SELECT on its sample tables only'

export const DEMO_SEARCH_UNAVAILABLE = 'not available in demo mode'

/** Well-known test PAN. Content detectors and `*.card` both see this shape. */
export const DEMO_CARD = '4111 1111 1111 1111'

export const DEMO_CUSTOMERS: Record<string, unknown>[] = [
  { id: 1, name: 'Ada Example', email: 'ada@example.com', card: DEMO_CARD },
  { id: 2, name: 'Bola Example', email: 'bola@example.com', card: DEMO_CARD },
  { id: 3, name: 'Cam Example', email: 'cam@example.com', card: DEMO_CARD },
  { id: 4, name: 'Deb Example', email: 'deb@example.com', card: DEMO_CARD },
  { id: 5, name: 'Eve Example', email: 'eve@example.com', card: DEMO_CARD },
]

export const DEMO_ORDERS: Record<string, unknown>[] = [
  { id: 10, customer_id: 1, total: 19.5, status: 'paid' },
  { id: 11, customer_id: 2, total: 42, status: 'paid' },
  { id: 12, customer_id: 3, total: 7.25, status: 'open' },
  { id: 13, customer_id: 4, total: 13, status: 'paid' },
]

/** Denied by policy before this connector is reached. No credential-shaped strings. */
export const DEMO_SECRETS: Record<string, unknown>[] = [
  { id: 1, note: 'sample-row-for-the-denied-table' },
  { id: 2, note: 'another-sample-row-for-the-denied-table' },
]

const COL: Omit<SchemaColumn, 'name'> = {
  type: 'text',
  nullable: true,
  isPrimary: false,
  isForeign: false,
}

function columns(names: string[]): SchemaColumn[] {
  return names.map((name, i) => ({
    ...COL,
    name,
    type: name === 'id' || name === 'customer_id' || name === 'total' ? 'number' : 'text',
    nullable: name !== 'id',
    isPrimary: i === 0 && name === 'id',
  }))
}

const TABLES: Record<string, { rows: Record<string, unknown>[]; fields: string[]; description: string }> = {
  'public.customers': {
    rows: DEMO_CUSTOMERS,
    fields: ['id', 'name', 'email', 'card'],
    description: 'Sample customers',
  },
  'public.orders': {
    rows: DEMO_ORDERS,
    fields: ['id', 'customer_id', 'total', 'status'],
    description: 'Sample orders',
  },
  'public.secrets': {
    rows: DEMO_SECRETS,
    fields: ['id', 'note'],
    description: 'Sample denied table',
  },
}

const QUALIFIED = Object.keys(TABLES)

function qualify(table: string): string {
  const t = table.trim().toLowerCase().replace(/"/g, '')
  if (!t) return t
  return t.includes('.') ? t : `public.${t}`
}

/**
 * After the gate has rewritten the statement, recover the sample table
 * name. Joins, computed SELECT, and anything that is not one of the
 * three sample tables are refused here — not executed.
 */
export function resolveDemoTable(sql: string): string {
  return parseDemoSelect(sql).table
}

// The gate emits its row cap as `LIMIT (n)`, with the parentheses.
const SIMPLE_SELECT = /^\s*select\s+(.+?)\s+from\s+([a-z0-9_."]+)\s*(?:limit\s+\(?\s*\d+\s*\)?\s*)?;?\s*$/is
const COLUMN_NAME = /^(?:[a-z_][a-z0-9_]*\.)*([a-z_][a-z0-9_]*)$/

/**
 * The one shape this connector answers: `SELECT <columns | *> FROM <sample
 * table> [LIMIT n]`. The column list is honoured, so a statement gets back
 * the columns it named and no others; a column the sample table does not
 * have is an error, as it would be on a database. WHERE, JOIN, expressions
 * and aliases are refused rather than ignored: ignoring them would return
 * rows the statement did not ask for.
 */
export function parseDemoSelect(sql: string): { table: string; columns: string[] } {
  const m = SIMPLE_SELECT.exec(sql)
  if (!m) throw new Error(DEMO_UNSUPPORTED_SQL)
  const table = qualify(m[2])
  const spec = TABLES[table]
  if (!spec) throw new Error(DEMO_UNSUPPORTED_SQL)
  const list = m[1].trim()
  if (list === '*') return { table, columns: spec.fields.slice() }
  const columns: string[] = []
  for (const raw of list.split(',')) {
    const name = COLUMN_NAME.exec(raw.trim().replace(/"/g, '').toLowerCase())
    if (!name) throw new Error(DEMO_UNSUPPORTED_SQL)
    if (!spec.fields.includes(name[1])) {
      throw new Error(`Column not found in sample table ${table}: ${name[1]}`)
    }
    if (!columns.includes(name[1])) columns.push(name[1])
  }
  return { table, columns }
}

function asTable(qualified: string): SchemaTable {
  const spec = TABLES[qualified]
  if (!spec) throw new Error(`Table not found: ${qualified}`)
  const name = qualified.slice(qualified.indexOf('.') + 1)
  return {
    schema: 'public',
    name,
    columns: columns(spec.fields),
    rowCount: spec.rows.length,
    description: spec.description,
  }
}

export class DemoConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  queryCalls = 0
  listCalls = 0
  describeCalls = 0
  searchCalls = 0

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'In-memory sample rows, not a database'
    this.capabilities = {
      canQuery: true,
      canListSchema: true,
      canDescribeTable: true,
      canSearch: false,
    }
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async listTables(): Promise<SchemaTable[]> {
    this.listCalls += 1
    return QUALIFIED.map(asTable)
  }

  async describeTable(table: string): Promise<SchemaTable> {
    this.describeCalls += 1
    const qualified = qualify(table)
    if (!TABLES[qualified]) throw new Error(`Table not found: ${table}`)
    return asTable(qualified)
  }

  async query(sql: string): Promise<QueryResult> {
    this.queryCalls += 1
    const { table, columns } = parseDemoSelect(sql)
    const spec = TABLES[table]
    return {
      rows: spec.rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))),
      rowCount: spec.rows.length,
      fields: columns,
      sql,
    }
  }

  async search(): Promise<QueryResult> {
    this.searchCalls += 1
    throw new Error(DEMO_SEARCH_UNAVAILABLE)
  }
}
