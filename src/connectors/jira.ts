import { Connector, ConnectorCapabilities, ConnectorConfig, QueryResult, SchemaTable } from '../types.js'

const MOCK_PROJECTS = [
  { scope: 'nex', key: 'NEX' },
]

export class JiraConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  private token: string

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'Jira Issues Connector (Stub)'
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
    return MOCK_PROJECTS.map(project => ({
      schema: 'jira',
      name: project.scope,
      columns: [
        { name: 'issueId', type: 'string', nullable: false, isPrimary: true, isForeign: false },
        { name: 'title', type: 'string', nullable: true, isPrimary: false, isForeign: false },
        { name: 'status', type: 'string', nullable: true, isPrimary: false, isForeign: false },
        { name: 'assignee', type: 'string', nullable: true, isPrimary: false, isForeign: false },
      ],
      description: `${project.key} project issues`,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const scope = this.normalizeScope(table)
    const found = (await this.listTables()).find(t => t.name === scope)
    if (!found) throw new Error(`Jira scope not found: ${table}`)
    return found
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    throw new Error('Not supported')
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    const allowedScopes = tables?.length ? new Set(tables.map(t => this.normalizeScope(t))) : undefined
    const rows = MOCK_PROJECTS
      .filter(project => !allowedScopes || allowedScopes.has(project.scope))
      .map(project => ({
        _table: `jira.${project.scope}`,
        issueId: `${project.key}-101`,
        title: `[MOCK] Implement ${query} feature`,
        status: 'In Progress',
        assignee: 'developer_emekcan',
      }))

    return {
      rows,
      rowCount: rows.length,
      fields: ['_table', 'issueId', 'title', 'status', 'assignee'],
    }
  }

  private normalizeScope(scope: string): string {
    const trimmed = scope.trim().toLowerCase()
    return trimmed.startsWith('jira.') ? trimmed.slice(5) : trimmed
  }
}
