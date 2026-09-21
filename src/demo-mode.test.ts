/**
 * Acceptance for `conarium --demo` (C1–C11). Each case is written to go
 * red if the behaviour is missing — the gate will see the red before green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  bootDemo,
  buildDemoConfig,
  demoStartBlocker,
  DemoModeRefused,
  DEMO_BANNER,
  DEMO_PRODUCTION_REFUSAL,
  main,
  parseCliFlags,
  attachStdio,
} from './cli.js'
import { parseConariumConfig } from './config.js'
import { loadConfig } from './server.js'
import { createConnector } from './connectors/index.js'
import {
  DEMO_CARD,
  DEMO_CUSTOMERS,
  DEMO_SEARCH_UNAVAILABLE,
  DEMO_UNSUPPORTED_SQL,
  DemoConnector,
} from './connectors/demo.js'
import { tableUnavailableMessage } from './table-unavailable.js'
import { verifyReceiptChain } from './receipt.js'
import { loadVerifyKeys, verifyHash } from './keys.js'
import * as updateCheck from './update-check.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const RAW_EMAILS = DEMO_CUSTOMERS.map((r) => String(r.email))

type ToolResult = {
  content?: { type: string; text: string }[]
  isError?: boolean
}

function toolText(out: ToolResult): string {
  return out.content?.[0]?.text ?? ''
}

function handlersOf(server: {
  _requestHandlers?: Map<string, (r: unknown) => Promise<unknown>>
}) {
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (r: unknown) => Promise<unknown>>
  })._requestHandlers
  return {
    async listTools(): Promise<string[]> {
      const h = handlers.get(ListToolsRequestSchema.shape.method.value)
      if (!h) throw new Error('ListTools handler missing')
      const listed = (await h({ method: 'tools/list', params: {} })) as {
        tools: { name: string }[]
      }
      return listed.tools.map((t) => t.name)
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const h = handlers.get(CallToolRequestSchema.shape.method.value)
      if (!h) throw new Error('CallTool handler missing')
      return (await h({
        method: 'tools/call',
        params: { name, arguments: args },
      })) as ToolResult
    },
  }
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** In-process stand-in for `conarium-verify <chain> --pubkey <key>`. */
function verifyKeptChain(receiptsPath: string, publicKeyPath: string): void {
  const receipts = readJsonl(receiptsPath)
  expect(receipts.length).toBeGreaterThan(0)
  const chain = verifyReceiptChain(receipts)
  expect(chain).toEqual(expect.objectContaining({ ok: true }))
  const keys = loadVerifyKeys([publicKeyPath])
  for (const row of receipts) {
    const rec = row as { chain?: { hash?: string }; sig?: { value?: string } }
    expect(rec.sig?.value).toBeTruthy()
    expect(rec.chain?.hash).toBeTruthy()
    expect(verifyHash(keys[0], rec.chain!.hash!, rec.sig!.value!)).toBe(true)
  }
}

function parseStdoutJsonRpc(raw: string): unknown[] {
  const out: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^content-length:/i.test(trimmed) || /^content-type:/i.test(trimmed)) continue
    const msg = JSON.parse(trimmed) as { jsonrpc?: unknown }
    if (msg.jsonrpc !== '2.0') {
      throw new Error(`stdout line is not JSON-RPC: ${trimmed}`)
    }
    out.push(msg)
  }
  return out
}

describe('parseCliFlags', () => {
  it('reads --demo and --keep', () => {
    expect(parseCliFlags(['--demo'])).toEqual({ demo: true, keep: false })
    expect(parseCliFlags(['--demo', '--keep'])).toEqual({ demo: true, keep: true })
    expect(parseCliFlags([])).toEqual({ demo: false, keep: false })
  })
})

describe('C9 type demo is refused from a config file', () => {
  it('parseConariumConfig names the --demo flag', () => {
    expect(() =>
      parseConariumConfig({
        connectors: [{ type: 'demo', name: 'demo', description: 'x', config: {} }],
      }),
    ).toThrow(/cannot be set in a config file.*--demo/)
  })

  it('loadConfig refuses a file that names type demo and does not open a server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-demo-cfg-'))
    const file = join(dir, 'conarium.config.json')
    writeFileSync(
      file,
      JSON.stringify({
        connectors: [{ type: 'demo', name: 'demo', description: 'x', config: {} }],
      }),
    )
    const prev = process.argv
    process.argv = ['node', 'conarium', '--config', file]
    try {
      expect(() => loadConfig()).toThrow(/cannot be set in a config file/)
    } finally {
      process.argv = prev
    }
  })
})

describe('demo connector sample rows', () => {
  it('refuses a statement that is not a sample-table SELECT', async () => {
    const conn = createConnector({
      type: 'demo',
      name: 'demo',
      description: 'sample',
      config: {},
    })
    expect(conn).toBeInstanceOf(DemoConnector)
    await expect(conn.query('SELECT 1')).rejects.toThrow(DEMO_UNSUPPORTED_SQL)
  })

  const demo = () => createConnector({ type: 'demo', name: 'demo', description: 'sample', config: {} })

  it('returns the columns the statement named and no others', async () => {
    const r = await demo().query('SELECT name FROM public.customers')
    expect(r.fields).toEqual(['name'])
    for (const row of r.rows) expect(Object.keys(row)).toEqual(['name'])
  })

  it('answers * with every sample column, and accepts quoted and qualified names', async () => {
    const all = await demo().query('SELECT * FROM customers')
    expect(all.fields).toEqual(['id', 'name', 'email', 'card'])
    const quoted = await demo().query('SELECT "customers"."email", "name" FROM "public"."customers" LIMIT 2;')
    expect(quoted.fields).toEqual(['email', 'name'])
  })

  it('names a column the sample table does not have instead of dropping it', async () => {
    await expect(demo().query('SELECT name, plan FROM public.customers')).rejects.toThrow(/Column not found.*plan/)
  })

  it('refuses WHERE, JOIN and expressions rather than ignoring them', async () => {
    for (const sql of [
      'SELECT name FROM public.customers WHERE id = 1',
      'SELECT c.name FROM public.customers c JOIN public.orders o ON o.customer_id = c.id',
      'SELECT count(*) FROM public.customers',
      'SELECT name AS n FROM public.customers',
    ]) {
      await expect(demo().query(sql)).rejects.toThrow(DEMO_UNSUPPORTED_SQL)
    }
  })
})

describe('conarium --demo', () => {
  const sessions: Array<{ stop: () => Promise<void> }> = []

  afterEach(async () => {
    while (sessions.length) {
      const s = sessions.pop()
      if (s) await s.stop().catch(() => {})
    }
  })

  it('C1 tools/list is the same four tools; search answers not available in demo mode', async () => {
    const session = await bootDemo()
    sessions.push(session)
    const tools = await handlersOf(session.server).listTools()
    expect(tools).toEqual(['list_tables', 'describe_table', 'query', 'search'])
    const search = await handlersOf(session.server).call('search', { query: 'ada' })
    expect(search.isError).toBe(true)
    expect(toolText(search)).toContain(DEMO_SEARCH_UNAVAILABLE)
  })

  it('C2 query customers masks email and card; raw sample values are absent', async () => {
    const session = await bootDemo()
    sessions.push(session)
    const out = await handlersOf(session.server).call('query', {
      sql: 'SELECT * FROM public.customers',
    })
    expect(out.isError).toBeFalsy()
    const body = toolText(out)
    const parsed = JSON.parse(body) as { rows: Record<string, unknown>[] }
    expect(parsed.rows.length).toBeGreaterThan(0)
    for (const row of parsed.rows) {
      expect(row.email).toBe('[MASKED_PII]')
      expect(row.card).toBe('[MASKED_PII]')
    }
    for (const email of RAW_EMAILS) {
      expect(body).not.toContain(email)
    }
    expect(body).not.toContain(DEMO_CARD)
    expect(body).not.toContain('4111111111111111')
  })

  it('C3 query secrets is refused by the same gate path; connector query count stays 0', async () => {
    const session = await bootDemo()
    sessions.push(session)
    expect(session.connector.queryCalls).toBe(0)
    const out = await handlersOf(session.server).call('query', {
      sql: 'SELECT * FROM public.secrets',
    })
    expect(out.isError).toBe(true)
    expect(toolText(out)).toContain(tableUnavailableMessage('public.secrets'))
    expect(session.connector.queryCalls).toBe(0)
  })

  it('C4 row cap: sample table is larger than maxRows; response is capped and marked truncated', async () => {
    const session = await bootDemo()
    sessions.push(session)
    expect(DEMO_CUSTOMERS.length).toBeGreaterThan(3)
    expect(buildDemoConfig(session.dir).policy?.maxRows).toBe(3)
    const out = await handlersOf(session.server).call('query', {
      sql: 'SELECT * FROM public.customers',
    })
    const parsed = JSON.parse(toolText(out)) as {
      rows: unknown[]
      rowCount: number
      truncated: boolean
    }
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.truncated).toBe(true)
    expect(parsed.rowCount).toBeGreaterThan(3)
  })

  it('C5 allowed and refused calls are recorded; --keep chain verifies in-process', async () => {
    const session = await bootDemo({ keep: true })
    sessions.push(session)
    await handlersOf(session.server).call('query', { sql: 'SELECT * FROM public.customers' })
    await handlersOf(session.server).call('query', { sql: 'SELECT * FROM public.secrets' })

    const audit = readJsonl(session.auditPath)
    const allowed = audit.filter((e) => e.tool === 'query' && e.denied === false)
    const refused = audit.filter((e) => e.tool === 'query' && e.denied === true)
    expect(allowed.length).toBeGreaterThan(0)
    expect(refused.length).toBeGreaterThan(0)

    const receipts = readJsonl(session.receiptsPath)
    expect(receipts.length).toBeGreaterThanOrEqual(2)
    verifyKeptChain(session.receiptsPath, session.publicKeyPath)

    await session.stop()
    expect(existsSync(session.dir)).toBe(true)
    verifyKeptChain(session.receiptsPath, session.publicKeyPath)
    rmSync(session.dir, { recursive: true, force: true })
  })

  it('C6 NODE_ENV=production exits nonzero; connector is not built; dir is not opened', async () => {
    expect(demoStartBlocker({ NODE_ENV: 'production' })).toBe(DEMO_PRODUCTION_REFUSAL)
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(bootDemo()).rejects.toBeInstanceOf(DemoModeRefused)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }

    const argv = process.argv
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.argv = ['node', 'conarium', '--demo']
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`EXIT:${code}`)
    }) as typeof process.exit)
    try {
      await expect(main()).rejects.toThrow(/EXIT:1/)
    } finally {
      exitSpy.mockRestore()
      process.argv = argv
      if (env === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = env
    }
  })

  it('C7 announceUpdate is not called; fetch is not used', async () => {
    const announce = vi.spyOn(updateCheck, 'announceUpdate')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const session = await bootDemo()
    sessions.push(session)
    expect(announce).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    announce.mockRestore()
    fetchSpy.mockRestore()
  })

  it('C8 stdout during boot is empty; stdio frames are JSON-RPC', async () => {
    const bootChunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      bootChunks.push(String(chunk))
      return origWrite(chunk as never, ...(rest as []))
    }) as typeof process.stdout.write
    let session
    try {
      session = await bootDemo()
      sessions.push(session)
    } finally {
      process.stdout.write = origWrite
    }
    expect(bootChunks.join('')).toBe('')

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const frames: string[] = []
    stdout.setEncoding('utf8')
    stdout.on('data', (c: string) => {
      frames.push(c)
    })
    const protoChunks: string[] = []
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      protoChunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await attachStdio(session!.server, stdin, stdout)
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'demo-mode-test', version: '0' },
          },
        })}\n`,
      )
      const raw = await new Promise<string>((resolve) => {
        const started = Date.now()
        const tick = () => {
          const joined = frames.join('') + protoChunks.join('')
          if (joined.includes('{') || Date.now() - started > 2500) {
            resolve(joined)
            return
          }
          setTimeout(tick, 25)
        }
        tick()
      })
      process.stdout.write = origWrite
      expect(raw.trim().length, 'stdio transport must write at least one JSON-RPC line').toBeGreaterThan(0)
      const messages = parseStdoutJsonRpc(raw)
      expect(messages.length).toBeGreaterThan(0)
      for (const msg of messages) {
        expect(msg).toEqual(expect.objectContaining({ jsonrpc: '2.0' }))
      }
    } finally {
      process.stdout.write = origWrite
    }
  })

  it('C10 default run removes the temp dir; --keep leaves it', async () => {
    const gone = await bootDemo({ keep: false })
    const goneDir = gone.dir
    await gone.stop()
    expect(existsSync(goneDir)).toBe(false)

    const kept = await bootDemo({ keep: true })
    sessions.push(kept)
    const keptDir = kept.dir
    await kept.stop()
    expect(existsSync(keptDir)).toBe(true)
    rmSync(keptDir, { recursive: true, force: true })
  })

  it('first stderr line states demo mode and sample rows', async () => {
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      const session = await bootDemo()
      sessions.push(session)
    } finally {
      console.error = orig
    }
    expect(lines[0]).toBe(DEMO_BANNER)
    expect(lines[0]).toMatch(/demo mode/)
    expect(lines[0]).toMatch(/sample rows/)
  })
})

describe('C11 package version', () => {
  it('package.json is 0.2.51', () => {
    expect(pkg.version).toBe('0.2.51')
  })
})
