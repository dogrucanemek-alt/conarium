/**
 * ZION Connector — Supabase/PostgreSQL with business context
 *
 * This is the reference connector implementation. It connects to a Supabase
 * instance and enriches the schema with business-domain descriptions so AI
 * assistants understand what the data MEANS, not just its shape.
 *
 * To use: copy and adapt for your own Supabase / PostgreSQL project.
 */
import type { Connector, ConnectorConfig, SchemaTable, QueryResult, ConnectorCapabilities } from '../types.js'
import { PostgresConnector } from './postgres.js'

const BUSINESS_CONTEXT: Record<string, string> = {
  // Add your table descriptions here — the AI will use these to understand context
  // Example:
  // 'orders': 'Customer purchase orders. Each row is one sale transaction.',
  // 'products': 'Product catalog with pricing and inventory.',
}

const COLUMN_CONTEXT: Record<string, string> = {
  // Column-level descriptions: { 'table.column': 'description' }
  // Example:
  // 'orders.status': 'Order status: pending, confirmed, delivered, cancelled, returned',
  // 'products.fiyat2': 'Actual selling price (Fiyat2). Fiyat3 is the inflated list price — use Fiyat2.',
}

export class ZionConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities = {
    canQuery: true,
    canListSchema: true,
    canDescribeTable: true,
    canSearch: true,
  }

  private pg: PostgresConnector

  constructor(config: ConnectorConfig) {
    this.name = config.name || 'zion'
    this.description = config.description || 'Company ERP database — sales, inventory, returns, expenses'

    // Supabase uses the transaction pooler for direct PostgreSQL access
    const supabaseUrl = config.config.supabaseUrl || config.config.url
    const serviceKey = config.config.serviceKey || config.config.key

    let pgUrl = supabaseUrl
    if (supabaseUrl?.includes('supabase.co') && serviceKey) {
      const host = new URL(supabaseUrl.replace('https://', 'postgresql://')).hostname
      pgUrl = `postgresql://postgres.${host.split('.')[0]}:${serviceKey}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`
    }

    this.pg = new PostgresConnector({
      ...config,
      config: {
        ...config.config,
        url: pgUrl || supabaseUrl,
        schemas: config.config.schemas || 'public',
      },
    })
  }

  async connect(): Promise<void> {
    await this.pg.connect()
  }

  async disconnect(): Promise<void> {
    await this.pg.disconnect()
  }

  async listTables(): Promise<SchemaTable[]> {
    const tables = await this.pg.listTables()
    return tables.map(t => ({
      ...t,
      description: BUSINESS_CONTEXT[t.name] || t.description,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const desc = await this.pg.describeTable(table)
    const tableName = table.includes('.') ? table.split('.')[1] : table
    return {
      ...desc,
      description: BUSINESS_CONTEXT[tableName] || desc.description,
      columns: desc.columns.map(col => ({
        ...col,
        description: COLUMN_CONTEXT[`${tableName}.${col.name}`] ?? col.description,
      })),
    }
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.pg.query(sql, params)
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    return this.pg.search(query, tables)
  }
}
