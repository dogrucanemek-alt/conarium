import { Connector, ConnectorCapabilities, ConnectorConfig, QueryResult, SchemaTable } from '../types.js'

const MOCK_CHANNELS = [
  { scope: 'engineering', channel: '#engineering' },
]

export class SlackConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  private token: string

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'Slack Messages Connector (Stub)'
    this.token = config.config?.token || ''
    this.capabilities = {
      canQuery: false,
      canListSchema: true,
      canDescribeTable: true,
      canSearch: true,
    }
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async listTables(): Promise<SchemaTable[]> {
    return MOCK_CHANNELS.map(ch => ({
      schema: 'slack',
      name: ch.scope,
      columns: [
        { name: 'channel', type: 'string', nullable: false, isPrimary: true, isForeign: false },
        { name: 'author', type: 'string', nullable: true, isPrimary: false, isForeign: false },
        { name: 'text', type: 'string', nullable: true, isPrimary: false, isForeign: false },
      ],
      description: ch.channel,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const scope = this.normalizeScope(table)
    const found = (await this.listTables()).find(t => t.name === scope)
    if (!found) throw new Error(`Slack scope not found: ${table}`)
    return found
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    throw new Error('Not supported')
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    const allowedScopes = tables?.length ? new Set(tables.map(t => this.normalizeScope(t))) : undefined
    const rows = MOCK_CHANNELS
      .filter(ch => !allowedScopes || allowedScopes.has(ch.scope))
      .map(ch => ({
        _table: `slack.${ch.scope}`,
        channel: ch.channel,
        author: 'U12345',
        text: `[MOCK] Discussion about ${query}`,
      }))

    return {
      rows,
      rowCount: rows.length,
      fields: ['_table', 'channel', 'author', 'text'],
    }
  }

  private normalizeScope(scope: string): string {
    const trimmed = scope.trim().toLowerCase()
    return trimmed.startsWith('slack.') ? trimmed.slice(6) : trimmed
  }
}
