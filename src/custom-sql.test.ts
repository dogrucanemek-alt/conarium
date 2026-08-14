/**
 * Operator SQL executor: the gate cannot be skipped. A malicious runner that
 * returns extra rows or raw PII still hits the cap and the mask; a deny never
 * calls the function.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type ConariumDeps } from './server.js'
import { Audit } from './audit.js'
import { Governance } from './governance.js'
import { parseConariumConfig } from './config.js'
import { createConnector } from './connectors/index.js'
import { CustomSqlConnector } from './connectors/custom-sql.js'
import { registerSqlExecutor, resetSqlExecutorsForTests } from './sql-executor.js'
import type { GovernancePolicy } from './types.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})
afterEach(() => {
  resetSqlExecutorsForTests()
})

const CUSTOM_CFG = {
  type: 'custom-sql' as const,
  name: 'memory',
  description: 'test executor',
  config: {},
}

function manyRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    email: `user${i + 1}@example.com`,
  }))
}

async function kur(opts: {
  execute: (sql: string) => Promise<unknown> | unknown
  policy?: GovernancePolicy
  name?: string
}) {
  const name = opts.name ?? 'memory'
  const calls: string[] = []
  registerSqlExecutor(name, async (sql) => {
    calls.push(sql)
    return opts.execute(sql)
  })
  const conn = createConnector({ ...CUSTOM_CFG, name })
  await conn.connect()
  const policy: GovernancePolicy = {
    allowConnectors: [name],
    allowTables: ['public.customers'],
    denyTables: ['public.secrets'],
    maskColumns: ['*.email'],
    maxRows: 50,
    dialect: 'postgres',
    ...opts.policy,
  }
  const deps: ConariumDeps = {
    config: { serverName: 'test', consumer: 'custom-sql', connectors: [] } as ConariumDeps['config'],
    governance: new Governance(policy),
    audit: new Audit({ consumer: 'custom-sql' }),
    connectors: [conn],
  }
  const server = buildServer(deps)
  const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
  return {
    conn,
    calls,
    async call(name: string, args: Record<string, unknown> = {}) {
      const h = handlers.get(CallToolRequestSchema.shape.method.value)
      if (!h) throw new Error('CallTool handler missing')
      return h({ method: 'tools/call', params: { name, arguments: args } }) as Promise<{
        isError?: boolean
        content?: { type: string; text: string }[]
      }>
    },
    async query(sql: string) {
      return this.call('query', { sql })
    },
  }
}

function payload(out: { content?: { text: string }[] }) {
  return JSON.parse(out.content?.[0]?.text ?? '{}') as {
    rowCount: number
    rows: Record<string, unknown>[]
    truncated?: boolean
    fields?: string[]
  }
}

describe('parseConariumConfig — custom-sql requires an explicit dialect', () => {
  it('rejects custom-sql when dialect is omitted — no silent postgres', () => {
    expect(() =>
      parseConariumConfig({
        connectors: [CUSTOM_CFG],
        policy: { allowConnectors: ['memory'], allowTables: ['public.customers'] },
      }),
    ).toThrow(/explicit policy\.dialect/)
  })

  it('accepts custom-sql when dialect is declared', () => {
    const cfg = parseConariumConfig({
      connectors: [CUSTOM_CFG],
      policy: {
        dialect: 'mssql',
        allowConnectors: ['memory'],
        allowTables: ['dbo.customers'],
      },
    })
    expect(cfg.policy?.dialect).toBe('mssql')
  })

  it('docs without dialect still loads (postgres default is only for shipped paths)', () => {
    const cfg = parseConariumConfig({
      connectors: [{ type: 'docs', name: 'docs', description: 'fixture', config: { path: './docs' } }],
      policy: { allowConnectors: ['docs'] },
    })
    expect(cfg.policy?.dialect).toBeUndefined()
  })
})

describe('custom-sql — the gate cannot be skipped', () => {
  it('query() is closed — the executor is not a public entry', async () => {
    registerSqlExecutor('memory', async () => ({ rows: [{ id: 1 }], fields: ['id'] }))
    const conn = createConnector(CUSTOM_CFG)
    await conn.connect()
    await expect(conn.query('SELECT id FROM public.secrets')).rejects.toThrow(/query\(\) is closed/)
    expect(conn).toBeInstanceOf(CustomSqlConnector)
  })

  it('malicious executor returning extra rows is still capped', async () => {
    const s = await kur({
      execute: () => ({ rows: manyRows(200), fields: ['id', 'email'] }),
    })
    const out = await s.query('SELECT id, email FROM public.customers')
    expect(out.isError).not.toBe(true)
    const body = payload(out)
    expect(body.rows).toHaveLength(50)
    expect(body.truncated).toBe(true)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatch(/\bLIMIT\b/i)
    expect(s.calls[0]).not.toBe('SELECT id, email FROM public.customers')
  })

  it('raw PII from the executor is masked on the way out', async () => {
    const s = await kur({
      execute: () => ({
        rows: [{ id: 1, email: 'ham-pii@example.com' }],
        fields: ['id', 'email'],
      }),
    })
    const out = await s.query('SELECT id, email FROM public.customers')
    const body = payload(out)
    expect(body.rows[0]?.email).toBe('[MASKED_PII]')
    expect(JSON.stringify(body)).not.toContain('ham-pii@example.com')
  })

  it('deny never calls the executor (counter stays 0)', async () => {
    const s = await kur({
      execute: () => ({ rows: [{ secret: 'SHOULD-NOT-RUN' }], fields: ['secret'] }),
    })
    const out = await s.query('SELECT secret FROM public.secrets')
    expect(out.isError).toBe(true)
    expect(s.calls).toHaveLength(0)
    expect(out.content?.[0]?.text ?? '').not.toContain('SHOULD-NOT-RUN')
  })

  it('executor throw is fail-closed — no rows leak', async () => {
    const s = await kur({
      execute: () => {
        throw new Error('driver boom')
      },
    })
    const out = await s.query('SELECT id FROM public.customers')
    expect(out.isError).toBe(true)
    const text = out.content?.[0]?.text ?? ''
    expect(text).toMatch(/failed closed/)
    expect(text).not.toMatch(/"rows"\s*:/)
  })

  it('config.module loads the in-memory example (no extra dependency)', async () => {
    const conn = createConnector({
      ...CUSTOM_CFG,
      name: 'example',
      config: { module: 'examples/custom-sql/memory-executor.mjs' },
    })
    await conn.connect()
    const deps: ConariumDeps = {
      config: { serverName: 'test', consumer: 'custom-sql', connectors: [] } as ConariumDeps['config'],
      governance: new Governance({
        allowConnectors: ['example'],
        allowTables: ['public.customers'],
        maskColumns: ['*.email'],
        maxRows: 50,
        dialect: 'postgres',
      }),
      audit: new Audit({ consumer: 'custom-sql' }),
      connectors: [conn],
    }
    const server = buildServer(deps)
    const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
    const h = handlers.get(CallToolRequestSchema.shape.method.value)
    if (!h) throw new Error('CallTool handler missing')
    const out = await h({
      method: 'tools/call',
      params: { name: 'query', arguments: { sql: 'SELECT id, email FROM public.customers' } },
    }) as { isError?: boolean; content?: { text: string }[] }
    expect(out.isError).not.toBe(true)
    const body = payload(out)
    expect(body.rows).toHaveLength(50)
    expect(body.rows.every((r) => r.email === '[MASKED_PII]')).toBe(true)
  })

  it('list_tables says schema discovery is not implemented — not a silent empty list', async () => {
    const s = await kur({ execute: () => ({ rows: [], fields: [] }) })
    const out = await s.call('list_tables')
    expect(out.isError).toBe(true)
    expect(out.content?.[0]?.text ?? '').toMatch(/does not list schema/)
    expect(out.content?.[0]?.text ?? '').not.toMatch(/\[\s*\]/)
  })

  it('describe_table on custom-sql is an explicit error, not an empty schema', async () => {
    const s = await kur({ execute: () => ({ rows: [], fields: [] }) })
    const out = await s.call('describe_table', { table: 'public.customers' })
    expect(out.isError).toBe(true)
    expect(out.content?.[0]?.text ?? '').toMatch(/does not describe tables/)
  })
})
