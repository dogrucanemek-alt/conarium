/**
 * The shipped MCP `query` tool must call the gate named in policy.dialect.
 * Unique emit (LIMIT / TOP / FETCH FIRST) is the proof of which function ran.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type ConariumDeps } from './server.js'
import { Audit } from './audit.js'
import { Governance } from './governance.js'
import { loadSqlGate } from './sql-gate/dispatch.js'
import type { Connector, GovernancePolicy, QueryResult, SchemaTable } from './types.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

function capturingConnector() {
  const seen: string[] = []
  const conn: Connector = {
    name: 'test',
    description: 'dialect cable',
    capabilities: { canQuery: true, canListSchema: false, canDescribeTable: false, canSearch: false },
    connect: async () => {},
    disconnect: async () => {},
    listTables: async (): Promise<SchemaTable[]> => [],
    describeTable: async (t: string): Promise<SchemaTable> => ({ name: t, schema: 'public', columns: [] }),
    query: async (sql: string): Promise<QueryResult> => {
      seen.push(sql)
      return { rows: [{ id: 1 }], rowCount: 1, fields: ['id'] }
    },
    search: async () => ({ rows: [], rowCount: 0, fields: [] }),
  }
  return { conn, seen }
}

async function kur(policy: GovernancePolicy) {
  if (policy.dialect) await loadSqlGate(policy.dialect)
  const { conn, seen } = capturingConnector()
  const deps: ConariumDeps = {
    config: { serverName: 'test', consumer: 'dialect-cable', connectors: [] } as ConariumDeps['config'],
    governance: new Governance({
      allowConnectors: [conn.name],
      maxRows: 50,
      ...policy,
    }),
    audit: new Audit({ consumer: 'dialect-cable' }),
    connectors: [conn],
  }
  const server = buildServer(deps)
  const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
  return {
    seen,
    async query(sql: string) {
      const h = handlers.get(CallToolRequestSchema.shape.method.value)
      if (!h) throw new Error('CallTool handler missing')
      return h({ method: 'tools/call', params: { name: 'query', arguments: { sql } } })
    },
  }
}

describe('MCP query tool selects the gate from policy.dialect', () => {
  it('omitted dialect is the postgres gate (LIMIT wrap)', async () => {
    const s = await kur({ allowTables: ['public.customers'] })
    await s.query('SELECT id FROM public.customers')
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0]).toMatch(/\bLIMIT\b/i)
    expect(s.seen[0]).not.toMatch(/\bTOP\s+\d+/i)
    expect(s.seen[0]).not.toMatch(/FETCH FIRST/i)
  })

  it('dialect postgres is the same emit as omitted', async () => {
    const omitted = await kur({ allowTables: ['public.customers'] })
    const explicit = await kur({ allowTables: ['public.customers'], dialect: 'postgres' })
    await omitted.query('SELECT id FROM public.customers')
    await explicit.query('SELECT id FROM public.customers')
    expect(explicit.seen[0]).toBe(omitted.seen[0])
  })

  it('dialect mssql calls guardMssqlQuery — connector sees TOP, not LIMIT', async () => {
    const s = await kur({ allowTables: ['dbo.customers'], dialect: 'mssql' })
    await s.query('SELECT id FROM dbo.customers')
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0]).toMatch(/TOP\s+50/i)
    expect(s.seen[0]).not.toMatch(/\bLIMIT\b/i)
  })

  it('dialect oracle calls guardOracleQuery — connector sees FETCH FIRST, not LIMIT', async () => {
    const s = await kur({ allowTables: ['app.customers'], dialect: 'oracle' })
    await s.query('SELECT id FROM app.customers')
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0]).toMatch(/FETCH FIRST 50 ROWS ONLY/i)
    expect(s.seen[0]).toMatch(/\bconarium_cap\b/)
    expect(s.seen[0]).not.toMatch(/\bLIMIT\b/i)
  })

  it('does not pick MSSQL just because the SQL contains TOP', async () => {
    const s = await kur({ allowTables: ['public.customers'] })
    const out = await s.query('SELECT TOP 50 id FROM public.customers') as { isError?: boolean; content?: { text: string }[] }
    expect(out.isError).toBe(true)
    expect(out.content?.[0]?.text).toMatch(/Failed to parse SQL/)
    expect(s.seen).toHaveLength(0)
  })
})
