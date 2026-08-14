/**
 * K2 evidence: search and describe_table are not "probably the same as query".
 * Traced through server.ts + search_policy.ts. Findings stay named; they are
 * not silently patched here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
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

function fixture(opts?: {
  search?: (q: string, tables?: string[]) => Promise<QueryResult>
  describe?: (t: string) => Promise<SchemaTable>
  tables?: SchemaTable[]
  policy?: ConstructorParameters<typeof Governance>[0]
  sink?: string
}) {
  const searchCalls: { q: string; tables?: string[] }[] = []
  const describeCalls: string[] = []
  const conn: Connector = {
    name: 'mem',
    description: 'k2 fixture',
    capabilities: { canQuery: false, canListSchema: true, canDescribeTable: true, canSearch: true },
    connect: async () => {},
    disconnect: async () => {},
    listTables: async () =>
      opts?.tables ?? [
        { schema: 'public', name: 'customers', columns: [] },
        { schema: 'public', name: 'secrets', columns: [] },
      ],
    describeTable: async (t) => {
      describeCalls.push(t)
      if (opts?.describe) return opts.describe(t)
      if (t === 'public.ghost') throw new Error('Table not found: public.ghost')
      const name = t.includes('.') ? t.split('.')[1] : t
      return {
        schema: 'public',
        name,
        columns: [
          { name: 'email', type: 'text', nullable: true, isPrimary: false, isForeign: false },
          { name: 'tckn', type: 'text', nullable: true, isPrimary: false, isForeign: false },
        ],
      }
    },
    query: async () => { throw new Error('query not used') },
    search: async (q, tables) => {
      searchCalls.push({ q, tables })
      if (opts?.search) return opts.search(q, tables)
      const rows: Record<string, unknown>[] = []
      for (const t of tables ?? []) {
        if (t === 'public.secrets') {
          rows.push({ _table: t, note: 'SECRET-ROW', email: 'secret@example.com' })
        }
        if (t === 'public.customers') {
          rows.push({ _table: t, note: `hit alice@example.com`, email: 'alice@example.com' })
        }
      }
      return { rows, rowCount: rows.length, fields: ['note', 'email'] }
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'conarium-k2-'))
  const sink = opts?.sink ?? join(dir, 'audit.jsonl')
  const deps: ConariumDeps = {
    config: { serverName: 'test', consumer: 'k2', connectors: [] } as ConariumDeps['config'],
    governance: new Governance({
      allowConnectors: ['mem'],
      allowTables: ['public.customers'],
      denyTables: ['public.secrets'],
      maskColumns: ['*.email'],
      maxRows: 3,
      ...opts?.policy,
    }),
    audit: new Audit({ consumer: 'k2', sink }),
    connectors: [conn],
  }
  const server = buildServer(deps)
  const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
  return {
    searchCalls,
    describeCalls,
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

function text(out: { content?: { text: string }[] }) {
  return out.content?.[0]?.text ?? ''
}

describe('describe_table — traced', () => {
  it('allowTables / denyTables run before the connector; denied table is never described', async () => {
    const s = fixture()
    const out = await s.call('describe_table', { table: 'public.secrets' })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/not available/)
    expect(text(out)).not.toMatch(/not permitted by policy/)
    expect(s.describeCalls).toEqual([])
  })

  it('unqualified name is denied (allowsTable requires schema.table)', async () => {
    const s = fixture()
    const out = await s.call('describe_table', { table: 'customers' })
    expect(out.isError).toBe(true)
    expect(s.describeCalls).toEqual([])
  })

  it('allowed table returns column names — schema is not masked', async () => {
    const s = fixture()
    const out = await s.call('describe_table', { table: 'public.customers' })
    expect(out.isError).not.toBe(true)
    const body = JSON.parse(text(out))
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(['email', 'tckn'])
    expect(s.describeCalls).toEqual(['public.customers'])
  })

  it('writes an audit line (denied and allowed)', async () => {
    const s = fixture()
    await s.call('describe_table', { table: 'public.secrets' })
    await s.call('describe_table', { table: 'public.customers' })
    const lines = readFileSync(s.sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].tool).toBe('describe_table')
    expect(lines[0].denied).toBe(true)
    expect(lines[1].denied).toBe(false)
    expect(lines[1].target).toBe('public.customers')
  })

  it('allow * + denyTables: assistant messages are indistinguishable', async () => {
    const s = fixture({
      policy: { allowConnectors: ['mem'], allowTables: ['*'], denyTables: ['public.secrets'] },
    })
    const denied = await s.call('describe_table', { table: 'public.secrets' })
    const missing = await s.call('describe_table', { table: 'public.ghost' })
    expect(denied.isError).toBe(true)
    expect(missing.isError).toBe(true)
    expect(text(denied).replace('public.secrets', 'T')).toBe(text(missing).replace('public.ghost', 'T'))
    expect(text(denied)).toMatch(/is not available/)
    expect(text(denied)).not.toMatch(/not permitted|Table not found/)
    expect(s.describeCalls).toEqual(['public.ghost'])
  })

  it('audit keeps the real reason when the assistant cannot tell', async () => {
    const s = fixture({
      policy: { allowConnectors: ['mem'], allowTables: ['*'], denyTables: ['public.secrets'] },
    })
    await s.call('describe_table', { table: 'public.secrets' })
    await s.call('describe_table', { table: 'public.ghost' })
    const lines = readFileSync(s.sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].reason).toMatch(/not permitted by policy/)
    expect(lines[1].reason).toMatch(/Table not found/)
    expect(lines[0].reason).not.toBe(lines[1].reason)
  })

  it('describe_table payload over 50KB is denied', async () => {
    const s = fixture({
      describe: async (t) => ({
        schema: 'public',
        name: t.split('.')[1] ?? t,
        columns: Array.from({ length: 4000 }, (_, i) => ({
          name: `col_${i}_${'x'.repeat(20)}`,
          type: 'text',
          nullable: true,
          isPrimary: false,
          isForeign: false,
        })),
      }),
    })
    const out = await s.call('describe_table', { table: 'public.customers' })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/50KB/)
  })
})

describe('search — traced', () => {
  it('scope is filterTables: secrets never reach the connector', async () => {
    const s = fixture()
    const out = await s.call('search', { query: 'alice' })
    expect(out.isError).not.toBe(true)
    expect(s.searchCalls).toHaveLength(1)
    expect(s.searchCalls[0].tables).toEqual(['public.customers'])
    expect(s.searchCalls[0].tables).not.toContain('public.secrets')
    expect(text(out)).not.toContain('SECRET-ROW')
  })

  it('asking for a denied table does not call search (counter 0)', async () => {
    const s = fixture()
    const out = await s.call('search', { query: 'alice', tables: ['public.secrets'] })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/not available/)
    expect(text(out)).not.toMatch(/not permitted|Table not found/)
    expect(s.searchCalls).toHaveLength(0)
  })

  it('search denied vs missing: same assistant text, distinct audit reasons', async () => {
    const s = fixture({
      policy: { allowConnectors: ['mem'], allowTables: ['*'], denyTables: ['public.secrets'] },
    })
    const denied = await s.call('search', { query: 'alice', tables: ['public.secrets'] })
    const missing = await s.call('search', { query: 'alice', tables: ['public.ghost'] })
    expect(text(denied).replace('public.secrets', 'T')).toBe(text(missing).replace('public.ghost', 'T'))
    expect(text(denied)).toMatch(/is not available/)
    const lines = readFileSync(s.sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].reason).toMatch(/not permitted by policy/)
    expect(lines[1].reason).toMatch(/Table not found/)
    expect(s.searchCalls).toHaveLength(0)
  })

  it('maskColumns and carry-over run on search rows', async () => {
    const s = fixture()
    const out = await s.call('search', { query: 'alice' })
    const body = JSON.parse(text(out))
    expect(body.rows[0].email).toBe('[MASKED_PII]')
    expect(JSON.stringify(body)).not.toContain('alice@example.com')
  })

  it('row cap and 50KB cap apply (maxRows 3)', async () => {
    const s = fixture({
      search: async () => ({
        rows: Array.from({ length: 20 }, (_, i) => ({ _table: 'public.customers', id: i, email: `u${i}@x.com` })),
        rowCount: 20,
        fields: ['id', 'email'],
      }),
    })
    const out = await s.call('search', { query: 'alice' })
    const body = JSON.parse(text(out))
    expect(body.rows).toHaveLength(3)
    expect(body.rowCount).toBe(3)
  })

  it('writes an audit line', async () => {
    const s = fixture()
    await s.call('search', { query: 'alice' })
    const lines = readFileSync(s.sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.some((l) => l.tool === 'search' && l.denied === false)).toBe(true)
  })
})

describe('query — table unavailable', () => {
  function queryFixture(policy?: ConstructorParameters<typeof Governance>[0]) {
    const queryCalls: string[] = []
    const conn: Connector = {
      name: 'mem',
      description: 'k2 query',
      capabilities: { canQuery: true, canListSchema: false, canDescribeTable: false, canSearch: false },
      connect: async () => {},
      disconnect: async () => {},
      listTables: async () => [],
      describeTable: async (t) => ({ schema: 'public', name: t, columns: [] }),
      query: async (sql) => {
        queryCalls.push(sql)
        if (/ghost/i.test(sql)) throw new Error('relation "public.ghost" does not exist')
        return { rows: [{ id: 1 }], rowCount: 1, fields: ['id'] }
      },
      search: async () => ({ rows: [], rowCount: 0, fields: [] }),
    }
    const dir = mkdtempSync(join(tmpdir(), 'conarium-k2q-'))
    const sink = join(dir, 'audit.jsonl')
    const deps: ConariumDeps = {
      config: { serverName: 'test', consumer: 'k2', connectors: [] } as ConariumDeps['config'],
      governance: new Governance({
        allowConnectors: ['mem'],
        allowTables: ['public.customers'],
        denyTables: ['public.secrets'],
        maxRows: 50,
        ...policy,
      }),
      audit: new Audit({ consumer: 'k2', sink }),
      connectors: [conn],
    }
    const server = buildServer(deps)
    const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
    return {
      queryCalls,
      sink,
      async call(sql: string) {
        const h = handlers.get(CallToolRequestSchema.shape.method.value)
        if (!h) throw new Error('CallTool handler missing')
        return h({ method: 'tools/call', params: { name: 'query', arguments: { sql } } }) as Promise<{
          isError?: boolean
          content?: { text: string }[]
        }>
      },
    }
  }

  it('default-deny still never calls the connector for a closed table', async () => {
    const s = queryFixture()
    const out = await s.call('SELECT id FROM public.secrets')
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/not available/)
    expect(s.queryCalls).toHaveLength(0)
  })

  it('allow * + deny: assistant cannot tell denied from missing; audit can', async () => {
    const s = queryFixture({ allowConnectors: ['mem'], allowTables: ['*'], denyTables: ['public.secrets'] })
    const denied = await s.call('SELECT id FROM public.secrets')
    const missing = await s.call('SELECT id FROM public.ghost')
    expect(text(denied).replace('public.secrets', 'T')).toBe(text(missing).replace('public.ghost', 'T'))
    expect(text(denied)).toMatch(/is not available/)
    expect(text(denied)).not.toMatch(/not permitted|does not exist/)
    expect(s.queryCalls).toHaveLength(1)
    expect(s.queryCalls[0]).toMatch(/ghost/i)
    const lines = readFileSync(s.sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].reason).toMatch(/not permitted by policy/)
    expect(lines[1].reason).toMatch(/does not exist/)
  })
})
