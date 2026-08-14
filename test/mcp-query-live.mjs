/**
 * Call the shipped MCP `query` tool with an operator-declared dialect.
 * The connector is the live engine (sqlcmd / sqlplus) — not a second gate.
 */
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from '../src/server.ts'
import { Audit } from '../src/audit.ts'
import { Governance } from '../src/governance.ts'
import { loadSqlGate } from '../src/sql-gate/dispatch.ts'

export async function callShippedQuery({ dialect, policy, execute, sql }) {
  process.env.CONARIUM_AUDIT_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED ?? '1'
  await loadSqlGate(dialect)
  const seen = []
  const conn = {
    name: 'live-engine',
    description: 'live dialect cable',
    capabilities: { canQuery: true, canListSchema: false, canDescribeTable: false, canSearch: false },
    connect: async () => {},
    disconnect: async () => {},
    listTables: async () => [],
    describeTable: async (t) => ({ name: t, schema: 'app', columns: [] }),
    query: async (gated) => {
      seen.push(gated)
      return execute(gated)
    },
    search: async () => ({ rows: [], rowCount: 0, fields: [] }),
  }
  const server = buildServer({
    config: { serverName: 'live', consumer: 'dialect-cable', connectors: [] },
    governance: new Governance({
      allowConnectors: [conn.name],
      dialect,
      ...policy,
    }),
    audit: new Audit({ consumer: 'dialect-cable' }),
    connectors: [conn],
  })
  const handlers = server._requestHandlers
  const h = handlers.get(CallToolRequestSchema.shape.method.value)
  if (!h) throw new Error('CallTool handler missing — MCP SDK internals changed')
  const result = await h({ method: 'tools/call', params: { name: 'query', arguments: { sql } } })
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? 'query denied'
    throw new Error(String(text).replace(/^Error:\s*/, ''))
  }
  return { result, seen }
}
