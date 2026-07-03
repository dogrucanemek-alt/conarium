import fs from 'fs/promises'
import path from 'path'
import { Connector, ConnectorCapabilities, ConnectorConfig, QueryResult, SchemaTable } from '../types.js'

interface DocCandidate {
  file: string
  fullPath: string
  relativePath: string
  scope: string
  size: number
}

export class DocsConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  private directoryPath: string
  private maxFiles: number
  private maxResults: number
  private maxFileBytes: number
  private maxPayloadBytes: number

  constructor(config: ConnectorConfig) {
    this.name = config.name
    this.description = config.description || 'Markdown / ADR Docs Connector'
    this.directoryPath = config.config?.path || './docs'
    this.maxFiles = this.parsePositiveInt(config.config?.maxSearchFiles, 1000)
    this.maxResults = this.parsePositiveInt(config.config?.maxSearchResults, 50)
    this.maxFileBytes = this.parsePositiveInt(config.config?.maxFileBytes, 256000)
    this.maxPayloadBytes = this.parsePositiveInt(config.config?.maxSearchBytes, 50000)
    this.capabilities = {
      canQuery: false,
      canListSchema: true,
      canDescribeTable: true,
      canSearch: true,
    }
  }

  async connect(): Promise<void> {
    const stat = await fs.stat(this.directoryPath).catch(() => undefined)
    if (!stat?.isDirectory()) {
      throw new Error(`Docs directory not found: ${this.directoryPath}`)
    }
  }

  async disconnect(): Promise<void> {}

  async listTables(): Promise<SchemaTable[]> {
    const docs = await this.collectDocs()
    return docs.map(doc => ({
      name: doc.scope,
      schema: 'docs',
      columns: [
        { name: 'file', type: 'string', nullable: false, isPrimary: true, isForeign: false },
        { name: 'path', type: 'string', nullable: false, isPrimary: false, isForeign: false },
        { name: 'contentSnippet', type: 'string', nullable: true, isPrimary: false, isForeign: false },
      ],
      rowCount: 1,
      description: doc.relativePath,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const scope = this.normalizeScope(table)
    const found = (await this.listTables()).find(t => t.name === scope)
    if (!found) throw new Error(`Docs scope not found: ${table}`)
    return found
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    throw new Error('Not supported')
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    const q = query.trim().toLowerCase()
    if (q.length < 3) {
      throw new Error('Docs search query must be at least 3 characters.')
    }

    const allowedScopes = tables?.length ? new Set(tables.map(t => this.normalizeScope(t))) : undefined
    const rows: Record<string, unknown>[] = []
    let payloadBytes = 0

    for (const doc of await this.collectDocs()) {
      if (allowedScopes && !allowedScopes.has(doc.scope)) continue
      if (rows.length >= this.maxResults) break

      const content = await fs.readFile(doc.fullPath, 'utf8')
      if (!content.toLowerCase().includes(q) && !doc.relativePath.toLowerCase().includes(q)) continue

      const row = {
        _table: `docs.${doc.scope}`,
        file: doc.file,
        path: doc.relativePath,
        contentSnippet: content.substring(0, 150) + (content.length > 150 ? '...' : ''),
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
      if (payloadBytes + rowBytes > this.maxPayloadBytes) break
      payloadBytes += rowBytes
      rows.push(row)
    }

    return {
      rows,
      rowCount: rows.length,
      fields: ['_table', 'file', 'path', 'contentSnippet'],
    }
  }

  private async collectDocs(): Promise<DocCandidate[]> {
    const root = path.resolve(this.directoryPath)
    const docs: DocCandidate[] = []

    const visit = async (dir: string): Promise<void> => {
      if (docs.length >= this.maxFiles) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (docs.length >= this.maxFiles) return
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await visit(fullPath)
          continue
        }
        if (!entry.isFile() || (!entry.name.endsWith('.md') && !entry.name.endsWith('.txt'))) continue

        const stat = await fs.stat(fullPath)
        if (stat.size > this.maxFileBytes) continue

        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/')
        docs.push({
          file: entry.name,
          fullPath,
          relativePath,
          scope: this.scopeForPath(relativePath),
          size: stat.size,
        })
      }
    }

    await visit(root)
    return docs
  }

  private scopeForPath(relativePath: string): string {
    const scope = relativePath.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    return scope || 'document'
  }

  private normalizeScope(scope: string): string {
    const trimmed = scope.trim()
    return trimmed.toLowerCase().startsWith('docs.') ? trimmed.slice(5) : trimmed
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
}
