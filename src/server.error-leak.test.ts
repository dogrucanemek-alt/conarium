/**
 * G13 — connector/DB error text must not reach the model with raw PII,
 * and every failed access must leave a denied audit line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type ConariumDeps } from './server.js'
import { Audit } from './audit.js'
import { Governance } from './governance.js'
import type { Connector, QueryResult, SchemaTable } from './types.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

const LEAK_EMAIL = 'alice@example.com'
const LEAK_TCKN = '12345678901'
const CAST_ERR = `invalid input syntax for type integer: "${LEAK_EMAIL}" (tckn ${LEAK_TCKN})`

function text(out: { content?: { text: string }[] }) {
  return out.content?.[0]?.text ?? ''
}

function sinkLines(sink: string) {
  if (!existsSync(sink)) return []
  const raw = readFileSync(sink, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((l) => JSON.parse(l) as { tool: string; denied?: boolean; reason?: string })
}

function fixture(opts: {
  query?: (sql: string) => Promise<QueryResult>
  search?: (q: string, tables?: string[]) => Promise<QueryResult>
  describe?: (t: string) => Promise<SchemaTable>
}) {
  const conn: Connector = {
    name: 'mem',
    description: 'g13 fixture',
    capabilities: { canQuery: true, canListSchema: true, canDescribeTable: true, canSearch: true },
    connect: async () => {},
    disconnect: async () => {},
    listTables: async () => [{ schema: 'public', name: 'customers', columns: [] }],
    describeTable: async (t) => {
      if (opts.describe) return opts.describe(t)
      return { schema: 'public', name: t.includes('.') ? t.split('.')[1] : t, columns: [] }
    },
    query: async (sql) => {
      if (opts.query) return opts.query(sql)
      return { rows: [], rowCount: 0, fields: [] }
    },
    search: async (q, tables) => {
      if (opts.search) return opts.search(q, tables)
      return { rows: [], rowCount: 0, fields: [] }
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'conarium-g13-'))
  const sink = join(dir, 'audit.jsonl')
  const deps: ConariumDeps = {
    config: { serverName: 'test', consumer: 'g13', connectors: [] } as ConariumDeps['config'],
    governance: new Governance({
      allowConnectors: ['mem'],
      allowTables: ['public.customers'],
      maxRows: 50,
    }),
    audit: new Audit({ consumer: 'g13', sink }),
    connectors: [conn],
  }
  const server = buildServer(deps)
  const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
  return {
    sink,
    async call(name: string, args: Record<string, unknown>) {
      const h = handlers.get(CallToolRequestSchema.shape.method.value)
      if (!h) throw new Error('CallTool handler missing')
      return h({ method: 'tools/call', params: { name, arguments: args } }) as Promise<{
        isError?: boolean
        content?: { text: string }[]
      }>
    },
  }
}

describe('G13 — raw PII in connector errors', () => {
  it('query: cast-style DB error is masked and denied-audited', async () => {
    const s = fixture({
      query: async () => { throw new Error(CAST_ERR) },
    })
    const out = await s.call('query', { sql: 'SELECT email FROM public.customers' })
    expect(out.isError).toBe(true)
    const body = text(out)
    expect(body).not.toContain(LEAK_EMAIL)
    expect(body).not.toContain(LEAK_TCKN)
    expect(body).toMatch(/MASKED/)
    const lines = sinkLines(s.sink)
    const denied = lines.filter((l) => l.tool === 'query' && l.denied === true)
    expect(denied).toHaveLength(1)
    expect(denied[0].reason).not.toContain(LEAK_EMAIL)
    expect(denied[0].reason).not.toContain(LEAK_TCKN)
    expect(denied[0].reason).toMatch(/MASKED/)
  })

  it('describe_table: non-missing connector error is masked and denied-audited', async () => {
    const s = fixture({
      describe: async () => { throw new Error(CAST_ERR) },
    })
    const out = await s.call('describe_table', { table: 'public.customers' })
    expect(out.isError).toBe(true)
    expect(text(out)).not.toContain(LEAK_EMAIL)
    expect(text(out)).not.toContain(LEAK_TCKN)
    const denied = sinkLines(s.sink).filter((l) => l.tool === 'describe_table' && l.denied === true)
    expect(denied).toHaveLength(1)
    expect(denied[0].reason).not.toContain(LEAK_EMAIL)
    expect(denied[0].reason).not.toContain(LEAK_TCKN)
  })

  it('search: connector error is masked and denied-audited', async () => {
    const s = fixture({
      search: async () => { throw new Error(CAST_ERR) },
    })
    const out = await s.call('search', { query: 'alice' })
    expect(out.isError).toBe(true)
    expect(text(out)).not.toContain(LEAK_EMAIL)
    expect(text(out)).not.toContain(LEAK_TCKN)
    const denied = sinkLines(s.sink).filter((l) => l.tool === 'search' && l.denied === true)
    expect(denied).toHaveLength(1)
    expect(denied[0].reason).not.toContain(LEAK_EMAIL)
    expect(denied[0].reason).not.toContain(LEAK_TCKN)
  })

  it('already-logged policy deny is not written twice', async () => {
    const s = fixture({})
    const out = await s.call('query', { sql: 'SELECT id FROM public.secrets' })
    expect(out.isError).toBe(true)
    const denied = sinkLines(s.sink).filter((l) => l.denied === true)
    expect(denied).toHaveLength(1)
  })
})
