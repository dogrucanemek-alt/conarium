import type { Connector, ConnectorCapabilities, ConnectorConfig, QueryResult, SchemaTable } from '../types.js'
import {
  loadExecutorModule,
  lookupSqlExecutor,
  normalizeExecutorResult,
  type SqlExecutorFn,
} from '../sql-executor.js'

/**
 * Operator SQL executor. `query()` is closed on purpose: ungated SQL must
 * not reach the function. The MCP `query` tool calls `runGoverned()` after
 * the gate. Schema discovery is optional and not implemented here.
 */
export class CustomSqlConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  private moduleSpec?: string
  private execute?: SqlExecutorFn

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'Operator SQL executor'
    this.moduleSpec = config.config?.module
    this.capabilities = {
      canQuery: true,
      canListSchema: false,
      canDescribeTable: false,
      canSearch: false,
    }
  }

  async connect(): Promise<void> {
    const registered = lookupSqlExecutor(this.name)
    if (registered) {
      this.execute = registered
      return
    }
    if (this.moduleSpec) {
      this.execute = await loadExecutorModule(this.moduleSpec)
      return
    }
    throw new Error(
      `Conarium: custom-sql connector "${this.name}" has no executor. ` +
        `Call registerSqlExecutor("${this.name}", fn) or set config.module.`,
    )
  }

  async disconnect(): Promise<void> {
    this.execute = undefined
  }

  async listTables(): Promise<SchemaTable[]> {
    throw new Error('custom-sql does not list schema.')
  }

  async describeTable(_table: string): Promise<SchemaTable> {
    throw new Error('custom-sql does not describe tables.')
  }

  async search(_query: string, _tables?: string[]): Promise<QueryResult> {
    throw new Error('custom-sql does not search.')
  }

  async query(_sql: string, _params?: unknown[]): Promise<QueryResult> {
    throw new Error(
      'Conarium: custom-sql.query() is closed. The executor only runs gated SQL through the MCP query tool.',
    )
  }

  async runGoverned(sql: string): Promise<QueryResult> {
    if (!this.execute) {
      throw new Error(`Conarium: custom-sql connector "${this.name}" is not connected.`)
    }
    let raw: unknown
    try {
      raw = await this.execute(sql)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'executor failed'
      throw new Error(`Conarium: custom-sql executor failed closed: ${msg}`)
    }
    return normalizeExecutorResult(raw)
  }
}
