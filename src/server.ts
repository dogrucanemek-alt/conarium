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
import type { Connector, ConnectorCapabilities } from './types.js'
import { createConnector } from './connectors/index.js'
import { Governance, PolicyError } from './governance.js'
import type { GovernanceMetadata } from './governance.js'
import { Audit } from './audit.js'
import type { ResolvedActor } from './tokens.js'
import { assertCustomSqlDialect, enforceProductionProfile, parseConariumConfig } from './config.js'
import { loadSqlGate, resolveSqlDialect } from './sql-gate/dispatch.js'
import { installedVersion } from './update-check.js'
import { capSearchResult, MAX_SEARCH_PAYLOAD_BYTES, readGovernedSchemaResource, resolveGovernedSearchScope } from './search_policy.js'
import {
  isMissingTableMessage,
  publicizeTableError,
  tableFromAccessDeny,
  tableUnavailableError,
} from './table-unavailable.js'
import { SupabaseRestConnector } from './connectors/supabase_rest.js'
import { CustomSqlConnector } from './connectors/custom-sql.js'

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
  enforceProductionProfile(config)
  // `allowsConnector` is fail-closed. Without this guard the symptom
  // would be a server that starts fine and answers every request with "not
  // permitted" — the operator would blame their policy, not a changed default.
  // Name the missing field and the connectors it should list.
  const allowList = config.policy?.allowConnectors
  if (config.connectors.length > 0 && (!allowList || allowList.length === 0)) {
    const names = config.connectors.map((c) => c.name).join('", "')
    throw new Error(
      `Conarium: ${config.connectors.length} connector(s) are configured but policy.allowConnectors is empty. ` +
        `Connectors are fail-closed: an empty list permits nothing (it previously meant "allow all"). ` +
        `Add policy.allowConnectors: ["${names}"] to your config, or remove the connectors.`,
    )
  }

  assertCustomSqlDialect(config)

  await loadSqlGate(resolveSqlDialect(config.policy?.dialect))
  const governance = new Governance(config.policy)
  const audit = new Audit({
    sink: config.audit?.sink,
    consumer: config.consumer,
    failClosed: config.audit?.failClosed,
    receiptSink: config.audit?.receiptSink,
    // v0.3: both are optional. A missing field becomes `source: 'undeclared'`
    // on the receipt — previously, if both were absent, no receipt was produced at all.
    receiptMeta: {
      model: config.audit?.receiptModel,
      client: config.audit?.receiptClient,
      destination: config.audit?.receiptDestination,
    },
    scanCharCap: config.policy?.scanCharCap,
    detectors: config.policy?.detectors,
    customPatterns: config.policy?.customPatterns,
  })
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

/**
 * custom-sql.query() is closed so ungated SQL cannot reach the operator
 * function. Only this path — after guardSql — calls runGoverned.
 */
async function runConnectorQuery(conn: Connector, guardedSql: string) {
  if (conn instanceof CustomSqlConnector) {
    return conn.runGoverned(guardedSql)
  }
  return conn.query(guardedSql)
}

/**
 * Build an MCP Server wired to the shared deps. One instance per transport/session.
 *
 * `aktor`: the person who opened THIS SESSION. Because the session is opened
 * with a single token, identity is fixed for the life of the session. Deliberately
 * a parameter — a module-level global would mix identities across concurrent
 * sessions and the audit record would blame the wrong person. If omitted,
 * behavior is as before (consumer).
 */
export function buildServer(
  { config, governance: temelGovernance, audit, connectors }: ConariumDeps,
  aktor?: ResolvedActor,
): Server {
  // Masking is resolved for the PERSON who opened this session. If there is no
  // profile, no actor, or a shared token, the base policy is returned — no silent
  // drift toward widening access.
  const governance = temelGovernance.forActor(aktor)
  // Pass the session identity into every audit line from ONE place: audit.log
  // is called 8+ times in this file and adding a field at each site would
  // eventually miss one.
  //
  // Client identity goes through the same place. `getClientVersion()` is the
  // value the peer REPORTED during MCP `initialize` — not a declaration, but
  // data measured from the protocol; marked `source: 'protocol'` on the receipt.
  // If the handshake has not happened yet it returns undefined and the receipt
  // falls back to the config declaration or "undeclared".
  const kaydet: typeof audit.log = (e) => {
    const ci = server.getClientVersion()
    return audit.log({
      ...e,
      ...(aktor ? { actor: aktor.id, actorAssurance: aktor.assurance } : {}),
      // Which masking profile was in force. Without this field, a receipt for
      // someone with a profile looks the same as one for someone without —
      // signed but an incomplete declaration. That is exactly the question
      // an auditor asks: masked for whom.
      ...(governance.appliedProfile() ? { policyProfile: governance.appliedProfile()! } : {}),
      ...(ci?.name ? { client: { name: ci.name, version: ci.version ?? '', source: 'protocol' as const } } : {}),
    })
  }

  const server = new Server(
    {
      name: config.serverName || 'Conarium',
      version: config.serverVersion || installedVersion() || 'unknown',
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
        description:
          'List the database tables this gateway is allowed to expose. Read-only. Returns one entry per table with its connector, schema-qualified name and description; tables the policy denies are absent rather than marked, so this is the authoritative list of what any other tool here can reach. Call it before describe_table or query when the table names are not already known. Every call is written to the audit ledger, and to a signed receipt as well when a receipt sink is configured.',
        inputSchema: {
          type: 'object',
          properties: {
            connector: { type: 'string', description: 'Connector name (optional, defaults to all)' },
          },
        },
      },
      {
        name: 'describe_table',
        description:
          'Get the columns of one table: name, type and description. Read-only, and it returns structure only — no row is read, so nothing here is masked. Use it to write a correct query; use list_tables first if the table name is not known. A table the policy denies returns an error rather than an empty result. Every call is written to the audit ledger, and to a signed receipt as well when a receipt sink is configured.',
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
        description:
          'Run one read-only SELECT against the company database. Only SELECT is allowed; anything else is refused before it reaches the database. Rows come back capped by the policy (maxRows, often lower than any LIMIT you write) and protected values arrive already replaced with [MASKED_PII] or [MASKED_SECRET] — the raw values never leave the gateway, so do not plan on receiving them. A refusal is a normal outcome, not a fault. Use search instead when there is no SELECT yet and the goal is to find text. Every call is written to the audit ledger, and to a signed receipt as well when a receipt sink is configured.',
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
        description:
          'Find rows by a search term across the allowed tables — no SQL required. Read-only. Use it when the goal is to look up text and there is no SELECT yet; use query when a SELECT already exists. Returns matching rows under the same policy as query: capped by maxRows, with protected values already replaced by [MASKED_PII] or [MASKED_SECRET]. The policy decides which scopes are searchable at all. Every call is written to the audit ledger, and to a signed receipt as well when a receipt sink is configured.',
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
    ].filter(t => governance.allowsTool(t.name)),
    // A tool closed by policy is also absent from the list. Otherwise the model
    // would see the tool, call it, and be refused — the only way to discover
    // it is closed would be to try, and every attempt would write noise to
    // the audit log.
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // Tool permission BEFORE everything else: a refused tool must never reach
    // a connector, a query, or the network. An audit line is still written —
    // a denied access is still an access attempt, and a receipt that did not
    // see it would be exactly the silence this product exists to avoid.
    if (!governance.allowsTool(name)) {
      kaydet({ tool: name, args: args as Record<string, unknown>, denied: true, reason: 'policy' })
      throw new PolicyError(`Tool '${name}' is not permitted by policy.`)
    }

    const getConnector = (preferredName?: string, need?: keyof ConnectorCapabilities): Connector => {
      if (!connectors.length) throw new Error('No connectors available. Check your conarium.config.json.')
      if (preferredName) {
        const found = connectors.find(c => c.name === preferredName)
        if (!found) throw new Error(`Connector '${preferredName}' not found. Available: ${connectors.map(c => c.name).join(', ')}`)
        if (!governance.allowsConnector(found.name)) throw new PolicyError(`Connector '${found.name}' is not permitted by policy.`)
        return found
      }
      // If no name is given: fall through to the first allowed connector that
      // meets the tool's need (e.g. canQuery) — otherwise a SQL query would
      // hit the first connector that cannot query (e.g. docs) and get "Not supported".
      const allowedAll = connectors.filter(c => governance.allowsConnector(c.name))
      const allowed = need ? (allowedAll.find(c => c.capabilities[need]) ?? allowedAll[0]) : allowedAll[0]
      if (!allowed) throw new PolicyError('No connector is permitted by policy.')
      return allowed
    }

    let accessRecorded = false
    const recordAccess: typeof kaydet = (e) => {
      accessRecorded = true
      return kaydet(e)
    }

    try {
      if (name === 'list_tables') {
        // If no name is given, ALL allowed connectors are listed — the tool
        // promises "all connectors"; falling through to the first one hid the
        // rest in a multi-connector setup.
        const preferred = (args as Record<string, string>)?.connector
        const targets = preferred
          ? [getConnector(preferred)]
          : connectors.filter(c => governance.allowsConnector(c.name) && c.capabilities.canListSchema)
        if (!targets.length) {
          const custom = connectors.filter(
            (c) => c instanceof CustomSqlConnector && governance.allowsConnector(c.name),
          )
          if (custom.length) {
            throw new Error(
              'custom-sql does not list schema. Schema discovery is not implemented on the operator executor.',
            )
          }
          throw new PolicyError('No connector is permitted by policy.')
        }

        const listed: Array<{ connector: string; name: string; description: string; rowCount?: number }> = []
        for (const conn of targets) {
          const tables = governance.filterTables(await conn.listTables())
          recordAccess({ tool: 'list_tables', target: conn.name, rowsReturned: tables.length, denied: false })
          for (const t of tables) {
            listed.push({
              connector: conn.name,
              name: `${t.schema}.${t.name}`,
              description: t.description || '',
              rowCount: t.rowCount,
            })
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(listed, null, 2) }],
        }
      }

      if (name === 'describe_table') {
        const a = args as { table: string; connector?: string }
        const conn = getConnector(a.connector, 'canDescribeTable')
        if (!governance.allowsTable(a.table)) {
          recordAccess({
            tool: 'describe_table',
            target: a.table,
            args: a,
            denied: true,
            reason: `Access to table '${a.table}' is not permitted by policy.`,
          })
          throw tableUnavailableError(a.table)
        }
        let table
        try {
          table = await conn.describeTable(a.table)
        } catch (err) {
          const real = (err as Error).message
          if (isMissingTableMessage(real)) {
            recordAccess({ tool: 'describe_table', target: a.table, args: a, denied: true, reason: real })
            throw tableUnavailableError(a.table)
          }
          throw err
        }
        const responseJson = JSON.stringify(table, null, 2)
        if (Buffer.byteLength(responseJson, 'utf8') > MAX_SEARCH_PAYLOAD_BYTES) {
          const limitErr = new Error('Response payload exceeds 50KB limit. Aggregation or massive row detected.')
          recordAccess({
            tool: 'describe_table',
            target: a.table,
            args: a,
            denied: true,
            reason: limitErr.message,
          })
          throw limitErr
        }
        recordAccess({
          tool: 'describe_table',
          target: a.table,
          args: a,
          denied: false,
          disclosurePayload: responseJson,
        })
        return {
          content: [{ type: 'text', text: responseJson }],
        }
      }

      if (name === 'query') {
        const a = args as { sql: string; connector?: string }
        const conn = getConnector(a.connector, 'canQuery')

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
            recordAccess({ tool: 'query', args: { sql: a.sql }, denied: true, reason: (err as Error).message })
            throw err
          }
          // Schema comes from the connector's configuration — a hard-coded
          // 'zion' default wrongly tripped policy on every query in setups
          // with another schema (demo, customer tenant).
          const schema = conn.schemaName
          const qualified = `${schema}.${parsed.table}`
          if (!governance.allowsTable(qualified)) {
            recordAccess({
              tool: 'query',
              target: qualified,
              args: a,
              denied: true,
              reason: `Access to table '${qualified}' is not permitted by policy.`,
            })
            throw tableUnavailableError(qualified)
          }
          const lim = Math.min(parsed.limit, governance.maxRows())
          guardedSql = `SELECT ${parsed.columns.join(', ')} FROM ${schema}.${parsed.table} LIMIT ${lim}`
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
            const res = governance.guardSql(a.sql)
            guardedSql = res.sql
            aliases = res.aliases
            guardMetadata = res.metadata
          } catch (err) {
            const policyMetadata = err instanceof PolicyError ? err.metadata : undefined
            const real = (err as Error).message
            recordAccess({ tool: 'query', args: { sql: a.sql }, denied: true, reason: real, governance: policyMetadata })
            const deniedTable = tableFromAccessDeny(real)
            if (deniedTable) throw tableUnavailableError(deniedTable)
            throw err
          }
          try {
            result = governance.redact(await runConnectorQuery(conn, guardedSql), aliases, guardMetadata)
          } catch (err) {
            const real = (err as Error).message
            if (isMissingTableMessage(real)) {
              const table = guardMetadata?.accessedTables?.[0] ?? 'unknown'
              recordAccess({
                tool: 'query',
                target: conn.name,
                args: { sql: a.sql },
                denied: true,
                reason: real,
                governance: guardMetadata,
              })
              throw tableUnavailableError(table)
            }
            throw err
          }
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
          recordAccess({
            tool: 'query',
            target: conn.name,
            args: { sql: a.sql },
            denied: true,
            reason: limitErr.message,
            governance: { ...result.governance, denied: true, denyReason: limitErr.message },
          })
          throw limitErr
        }

        recordAccess({
          tool: 'query',
          target: conn.name,
          args: { sql: a.sql },
          rowsReturned: Math.min(result.rowCount, cap),
          maskedCount: result.governance.maskedCount,
          denied: false,
          governance: result.governance,
          disclosurePayload: responseJson,
        })

        return {
          content: [{ type: 'text', text: responseJson }],
        }
      }

      if (name === 'search') {
        const a = args as { query: string; tables?: string[]; connector?: string }
        const conn = getConnector(a.connector, 'canSearch')
        let requested: string[]

        try {
          requested = await resolveGovernedSearchScope(conn, governance, a.query, a.tables)
        } catch (err) {
          recordAccess({ tool: 'search', target: conn.name, args: a, denied: true, reason: (err as Error).message })
          publicizeTableError(err, a.tables?.[0])
        }

        const capped = capSearchResult(await conn.search(a.query, requested), governance.maxRows())
        const result = governance.redact(capped)
        // Collect the tables the search result ACTUALLY touched from _table on
        // the rows. entry.target is the connector name (not a table) — writing
        // it onto the receipt as the object would be wrong data. If result rows
        // carry _table, record those; if not, leave empty (falls into the
        // "unknown" coverage counter — no fabrication).
        const searchTables = [...new Set(result.rows.map((r) => (r as Record<string, unknown>)._table).filter(Boolean))] as string[]
        const searchGovernance = searchTables.length
          ? { ...result.governance, accessedTables: searchTables }
          : result.governance
        const searchJson = JSON.stringify(result, null, 2)
        recordAccess({
          tool: 'search',
          target: conn.name,
          args: a,
          rowsReturned: result.rowCount,
          denied: false,
          governance: searchGovernance,
          disclosurePayload: searchJson,
        })
        return {
          content: [{ type: 'text', text: searchJson }],
        }
      }

      throw new Error(`Unknown tool: ${name}`)
    } catch (err) {
      const raw = (err as Error).message || String(err)
      const masked = audit.maskText(raw)
      if (!accessRecorded) {
        recordAccess({
          tool: name,
          args: (args ?? {}) as Record<string, unknown>,
          denied: true,
          reason: masked,
        })
      }
      return {
        content: [{ type: 'text', text: `Error: ${masked}` }],
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
