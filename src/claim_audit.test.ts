/**
 * Claim audit (2026-08-15). Every public sentence is a test case.
 *
 * S1 — published demo token must not appear in OUR bodies / logs.
 * S3 — a holder of a valid token still cannot unmask or dump.
 * WHERE-blind is a finding, not a green contract: see the skipped case.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Governance, PolicyError } from './governance.js'
import { applyPostgresRowCap, parsePostgresSql } from './sql-gate/postgres.js'
import { BLOCKED_DUMP_FUNCTIONS } from './sql-gate/rules.js'

const PAYLASILAN = 'paylasilan-token-en-az-24-karakter-uzun'
const LEAKME = 'LEAKME-claim-audit-token-24xx'
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

let createHandler: (
  deps: unknown,
  transports: Map<string, unknown>,
  limiter: { take: () => boolean; retryAfter: () => number; enabled: boolean },
) => (req: unknown, res: unknown) => Promise<void>

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-claim-'))
  const tokensFile = join(dir, 'conarium.tokens.json')
  writeFileSync(tokensFile, JSON.stringify({ tokens: [] }))
  process.env.CONARIUM_TOKENS_FILE = tokensFile
  process.env.CONARIUM_MCP_TOKEN = PAYLASILAN
  const mod = await import('./http.js')
  createHandler = mod.createHandler
})

function sahteYanit() {
  const kayit = { status: 0, body: '', headersSent: false, headers: {} as Record<string, string> }
  return {
    kayit,
    writeHead(status: number, headers?: Record<string, string>) {
      kayit.status = status
      kayit.headers = headers || {}
      kayit.headersSent = true
      return this
    },
    end(body?: string) {
      kayit.body = String(body ?? '')
    },
    get headersSent() {
      return kayit.headersSent
    },
  }
}

const deps = { config: { consumer: 'servis' }, connectors: [], governance: {}, audit: {} }
const limiter = { take: () => true, retryAfter: () => 0, enabled: false }

function pathReq(token: string, method = 'GET') {
  return {
    url: `/t/${token}/mcp`,
    method,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function bearerReq(token: string, method = 'GET') {
  return {
    url: '/mcp',
    method,
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

const DEMO = new Governance({
  allowTables: ['demo.*'],
  denyTables: ['demo.customers', 'public.secrets'],
  maskColumns: ['*.email', '*.phone', '*.tckn'],
  maxRows: 25,
})

describe('S1 published token is not echoed by our code', () => {
  it('401 path-token response and stderr do not contain the raw token', async () => {
    const captured: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '))
    }
    try {
      const res = sahteYanit()
      await createHandler(deps, new Map(), limiter)(pathReq(LEAKME), res)
      expect(res.kayit.status).toBe(401)
      expect(res.kayit.body).not.toContain(LEAKME)
      expect(JSON.stringify(res.kayit.headers)).not.toContain(LEAKME)
      expect(captured.join('\n')).not.toContain(LEAKME)
    } finally {
      console.error = orig
    }
  })

  it('authorized path-token 400 body does not contain the credential', async () => {
    const res = sahteYanit()
    await createHandler(deps, new Map(), limiter)(pathReq(PAYLASILAN), res)
    expect(res.kayit.status).toBe(400)
    expect(res.kayit.body).not.toContain(PAYLASILAN)
    expect(res.kayit.body).toMatch(/no session|initialize/)
  })

  it('path token and Bearer of the same credential produce the same status', async () => {
    for (const token of [LEAKME, PAYLASILAN]) {
      const viaPath = sahteYanit()
      const viaBearer = sahteYanit()
      await createHandler(deps, new Map(), limiter)(pathReq(token), viaPath)
      await createHandler(deps, new Map(), limiter)(bearerReq(token), viaBearer)
      expect(viaPath.kayit.status, token).toBe(viaBearer.kayit.status)
    }
  })

  it('session owner key is the sha256 of the token, not the token', async () => {
    const mod = await import('./http.js')
    const key = mod.ownerKey(LEAKME)
    expect(key.toString('hex')).toBe(sha256hex(LEAKME))
    expect(key.toString('utf8')).not.toContain(LEAKME)
  })
})

describe('S1/S3 demo-shaped policy', () => {
  it('allows demo.* that is not on the deny list', () => {
    expect(() => DEMO.guardQuery('SELECT id FROM demo.accounts')).not.toThrow()
  })

  it('denies JOIN / CTE / alias onto demo.customers and public.secrets', () => {
    const attacks = [
      'SELECT a.id FROM demo.accounts a JOIN demo.customers c ON c.id = a.id',
      'WITH x AS (SELECT id FROM demo.customers) SELECT * FROM x',
      'SELECT s.id FROM public.secrets AS s',
      'SELECT id FROM (SELECT id FROM public.secrets) AS x',
    ]
    for (const sql of attacks) {
      expect(() => DEMO.guardQuery(sql), sql).toThrow(PolicyError)
    }
  })
})

describe('S3 malicious assistant cannot unmask via SQL', () => {
  it('concat(email) is allowed and the output is marked masked', () => {
    const guarded = DEMO.guardQuery("SELECT concat(email, 'x') AS c FROM demo.accounts")
    expect(guarded.metadata.maskedFields.map((f) => f.toLowerCase())).toContain('c')
    const out = DEMO.redact(
      {
        rows: [{ _table: 'demo.accounts', c: 'ada@bank.testx' }],
        rowCount: 1,
        fields: ['_table', 'c'],
      },
      {},
      guarded.metadata,
    )
    expect(out.rows[0].c).toBe('[MASKED_PII]')
    expect(JSON.stringify(out)).not.toContain('ada@bank.test')
  })

  it('to_json / dump aggregates are denied', () => {
    expect(() => DEMO.guardQuery('SELECT to_json(email) FROM demo.accounts')).toThrow(PolicyError)
    for (const fn of BLOCKED_DUMP_FUNCTIONS) {
      expect(() => DEMO.guardQuery(`SELECT ${fn}(email) FROM demo.accounts`), fn).toThrow(PolicyError)
    }
  })

  it('docs-like free text with an email is redacted on the search path', () => {
    const out = DEMO.redact({
      rows: [
        {
          _table: 'docs.readme',
          file: 'note.md',
          contentSnippet: 'contact ada@bank.test for the vault',
        },
      ],
      rowCount: 1,
      fields: ['_table', 'file', 'contentSnippet'],
    })
    expect(String(out.rows[0].contentSnippet)).not.toContain('ada@bank.test')
    expect(String(out.rows[0].contentSnippet)).toContain('[MASKED_PII]')
  })

  it('row cap preserves OFFSET — per-query, not per-session', () => {
    const ast = parsePostgresSql('SELECT id FROM demo.accounts OFFSET 25')
    applyPostgresRowCap(ast[0], 25)
    const sql = JSON.stringify(ast[0])
    expect(sql).toMatch(/offset/i)
    expect(sql).toMatch(/25/)
  })

  // Finding, not a contract. Masking is on result rows. A WHERE on a masked
  // column is sent to the database; rowCount 1 vs 0 is a blind channel.
  // Do not encode that leak as desired behaviour. See the 2026-08-15 report.
  it.skip('WHERE-blind on a masked column is a design decision, not a green pin', () => {
    DEMO.guardQuery("SELECT id FROM demo.accounts WHERE email LIKE 'a%'")
  })
})
