/**
 * Conarium server core — shared by stdio (index.ts) and remote HTTP (http.ts) entrypoints.
 * Behavior is identical to the original inline main(): same tools, same governance, same audit.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { ConariumConfig } from './types.js'
import type { Connector } from './types.js'
import { createConnector } from './connectors/index.js'
import { Governance, PolicyError } from './governance.js'
import type { GovernanceMetadata } from './governance.js'
import { Audit } from './audit.js'
import { parseConariumConfig } from './config.js'
import { capSearchResult, readGovernedSchemaResource, resolveGovernedSearchScope } from './search_policy.js'
import { SupabaseRestConnector } from './connectors/supabase_rest.js'

export interface ConariumDeps {
  config: ConariumConfig
  governance: Governance
  audit: Audit
  connectors: Connector[]
}

export function loadConfig(): ConariumConfig {
  const args = process.argv.slice(2)
  const configIdx = args.indexOf('--config')
  const configPath = configIdx >= 0 ? args[configIdx + 1] : 'conarium.config.json'
  const resolvedPath = resolve(process.cwd(), configPath)

  if (!existsSync(resolvedPath)) {
    return {
      serverName: 'Conarium',
      connectors: [],
    }
  }

  const raw = readFileSync(resolvedPath, 'utf-8')
  return parseConariumConfig(JSON.parse(raw))
}

/** Connect all configured connectors once (shared across sessions in HTTP mode). */
export async function bootDeps(config: ConariumConfig): Promise<ConariumDeps> {
  const governance = new Governance(config.policy)
  const audit = new Audit({ sink: config.audit?.sink, consumer: config.consumer, failClosed: config.audit?.failClosed })
  const connectors: Connector[] = []

  for (const cfg of config.connectors) {
    try {
      const conn = createConnector(cfg)
      await conn.connect()
      connectors.push(conn)
      console.error(`[conarium] Connected: ${cfg.name} (${cfg.type})`)
    } catch (err) {
      console.error(`[conarium] Failed to connect ${cfg.name}:`, (err as Error).message)
    }
  }

  if (connectors.length === 0) {
    console.error('[conarium] No connectors configured. Add a conarium.config.json file.')
  }

  return { config, governance, audit, connectors }
}

/** Build an MCP Server wired to the shared deps. One instance per transport/session. */
export function buildServer({ config, governance, audit, connectors }: ConariumDeps): Server {
  const server = new Server(
    {
      name: config.serverName || 'Conarium',
      version: config.serverVersion || '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_tables',
        description: 'List all database tables available in the company data connectors',
        inputSchema: {
          type: 'object',
          properties: {
            connector: { type: 'string', description: 'Connector name (optional, defaults to all)' },
          },
        },
      },
      {
        name: 'describe_table',
        description: 'Get the schema and column descriptions of a specific table',
        inputSchema: {
          type: 'object',
          required: ['table'],
          properties: {
            table: { type: 'string', description: 'Schema-qualified table name' },
            connector: { type: 'string', description: 'Connector name (optional)' },
          },
        },
      },
      {
        name: 'query',
        description: 'Run a read-only SQL query against the company database. Only SELECT is allowed.',
        inputSchema: {
          type: 'object',
          required: ['sql'],
          properties: {
            sql: { type: 'string', description: 'SQL SELECT query to execute' },
            connector: { type: 'string', description: 'Connector name (optional, defaults to first allowed)' },
          },
        },
      },
      {
        name: 'search',
        description: 'Full-text search across governed company data scopes',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search term' },
            tables: { type: 'array', items: { type: 'string' }, description: 'Schema-qualified search scopes' },
            connector: { type: 'string', description: 'Connector name (optional)' },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    const getConnector = (preferredName?: string): Connector => {
      if (!connectors.length) throw new Error('No connectors available. Check your conarium.config.json.')
      if (preferredName) {
        const found = connectors.find(c => c.name === preferredName)
        if (!found) throw new Error(`Connector '${preferredName}' not found. Available: ${connectors.map(c => c.name).join(', ')}`)
        if (!governance.allowsConnector(found.name)) throw new PolicyError(`Connector '${found.name}' is not permitted by policy.`)
        return found
      }
      const allowed = connectors.find(c => governance.allowsConnector(c.name))
      if (!allowed) throw new PolicyError('No connector is permitted by policy.')
      return allowed
    }

    try {
      if (name === 'list_tables') {
        const conn = getConnector((args as Record<string, string>)?.connector)
        const tables = governance.filterTables(await conn.listTables())
        audit.log({ tool: 'list_tables', target: conn.name, rowsReturned: tables.length, denied: false })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                tables.map(t => ({
                  name: `${t.schema}.${t.name}`,
                  description: t.description || '',
                  rowCount: t.rowCount,
                })),
                null,
                2
              ),
            },
          ],
        }
      }

      if (name === 'describe_table') {
        const a = args as { table: string; connector?: string }
        const conn = getConnector(a.connector)
        if (!governance.allowsTable(a.table)) {
          audit.log({ tool: 'describe_table', target: a.table, args: a, denied: true, reason: 'policy' })
          throw new PolicyError(`Access to table '${a.table}' is not permitted by policy.`)
        }
        const table = await conn.describeTable(a.table)
        audit.log({ tool: 'describe_table', target: a.table, args: a, denied: false })
        return {
          content: [{ type: 'text', text: JSON.stringify(table, null, 2) }],
        }
      }

      if (name === 'query') {
        const a = args as { sql: string; connector?: string }
        const conn = getConnector(a.connector)

        let guardedSql = a.sql
        let aliases: Record<string, string> = {}
        let guardMetadata: GovernanceMetadata | undefined
        let result

        // PostgREST path: no Postgres AST rewrite (would break MSSQL/REST simple SELECT).
        if (conn instanceof SupabaseRestConnector) {
          let parsed
          try {
            parsed = conn.parseSimpleSelect(a.sql)
          } catch (err) {
            audit.log({ tool: 'query', args: { sql: a.sql }, denied: true, reason: (err as Error).message })
            throw err
          }
          const qualified = `zion.${parsed.table}`
          if (!governance.allowsTable(qualified)) {
            audit.log({ tool: 'query', target: qualified, args: a, denied: true, reason: 'policy' })
            throw new PolicyError(`Access to table '${qualified}' is not permitted by policy.`)
          }
          const lim = Math.min(parsed.limit, governance.maxRows())
          guardedSql = `SELECT ${parsed.columns.join(', ')} FROM zion.${parsed.table} LIMIT ${lim}`
          guardMetadata = {
            accessedTables: [qualified],
            accessedFunctions: [],
            appliedRowCap: lim,
            maskedFields: [],
            maskedCount: 0,
            denied: false,
          }
          result = governance.redact(await conn.query(guardedSql), aliases, guardMetadata)
        } else {
          try {
            const res = governance.guardQuery(a.sql)
            guardedSql = res.sql
            aliases = res.aliases
            guardMetadata = res.metadata
          } catch (err) {
            const policyMetadata = err instanceof PolicyError ? err.metadata : undefined
            audit.log({ tool: 'query', args: { sql: a.sql }, denied: true, reason: (err as Error).message, governance: policyMetadata })
            throw err
          }
          result = governance.redact(await conn.query(guardedSql), aliases, guardMetadata)
        }

        const cap = governance.maxRows()
        const responseJson = JSON.stringify(
          {
            rowCount: result.rowCount,
            fields: result.fields,
            rows: result.rows.slice(0, cap),
            truncated: result.rowCount > cap,
          },
          null,
          2
        )

        if (Buffer.byteLength(responseJson, 'utf8') > 50000) {
          const limitErr = new Error('Response payload exceeds 50KB limit. Aggregation or massive row detected.')
          audit.log({
            tool: 'query',
            target: conn.name,
            args: { sql: a.sql },
            denied: true,
            reason: limitErr.message,
            governance: { ...result.governance, denied: true, denyReason: limitErr.message },
          })
          throw limitErr
        }

        audit.log({
          tool: 'query',
          target: conn.name,
          args: { sql: a.sql },
          rowsReturned: Math.min(result.rowCount, cap),
          maskedCount: result.governance.maskedCount,
          denied: false,
          governance: result.governance,
        })

        return {
          content: [{ type: 'text', text: responseJson }],
        }
      }

      if (name === 'search') {
        const a = args as { query: string; tables?: string[]; connector?: string }
        const conn = getConnector(a.connector)
        let requested: string[]

        try {
          requested = await resolveGovernedSearchScope(conn, governance, a.query, a.tables)
        } catch (err) {
          audit.log({ tool: 'search', target: conn.name, args: a, denied: true, reason: (err as Error).message })
          throw err
        }

        const capped = capSearchResult(await conn.search(a.query, requested), governance.maxRows())
        const result = governance.redact(capped)
        audit.log({ tool: 'search', target: conn.name, args: a, rowsReturned: result.rowCount, denied: false })
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
      }

      throw new Error(`Unknown tool: ${name}`)
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: connectors.filter(conn => governance.allowsConnector(conn.name)).map(conn => ({
      uri: `conarium://${conn.name}/schema`,
      name: `${conn.name} schema`,
      description: conn.description,
      mimeType: 'application/json',
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    const connName = uri.replace('conarium://', '').replace('/schema', '')
    const conn = connectors.find(c => c.name === connName)
    if (!conn) throw new Error(`Connector not found: ${connName}`)
    const content = await readGovernedSchemaResource(conn, governance, audit, uri)
    return { contents: [content] }
  })

  return server
}
