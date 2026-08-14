import express, { type NextFunction, type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { Governance } from './governance.js'
import { Audit } from './audit.js'
import { RateLimiter, clientKey } from './rate_limit.js'
import { createHandoffStore, createSessionStore } from './console-handoff.js'
import {
  findReceipt,
  loadReceiptsForConsole,
  publicPemForPanel,
  toListItems,
  verifyCommandFor,
} from './console-receipts.js'
import { receiptToView, renderReceiptHtml } from './receipt-view.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const DEFAULT_CONSOLE_HOST = '127.0.0.1'

const ConsolePolicyPatchSchema = z.object({
  maxRows: z.number().int().positive().max(10000).optional(),
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  allowTables: z.array(z.string()).optional(),
  denyTables: z.array(z.string()).optional(),
  maskColumns: z.array(z.string()).optional(),
  // Accepted from older UI payloads. Not a config field — never written.
  piiMasking: z.boolean().optional(),
}).strict()

export type ConsolePolicyPatch = z.infer<typeof ConsolePolicyPatchSchema>

const POLICY_PATCH_KEYS = ['maxRows', 'allowTools', 'denyTools', 'allowTables', 'denyTables', 'maskColumns'] as const

export function validateConsoleConfig(input: unknown): ConsolePolicyPatch {
  return ConsolePolicyPatchSchema.parse(input)
}

/**
 * Overlay only the governance fields the console edits. connectors, audit,
 * profiles and actorProfiles stay as they were — dropping them would be a
 * silent policy downgrade.
 */
export function mergeConsolePolicyPatch(
  existing: Record<string, unknown>,
  patch: ConsolePolicyPatch,
): Record<string, unknown> {
  const prev =
    existing.policy && typeof existing.policy === 'object' && !Array.isArray(existing.policy)
      ? { ...(existing.policy as Record<string, unknown>) }
      : {}
  for (const k of POLICY_PATCH_KEYS) {
    if (patch[k] !== undefined) prev[k] = patch[k]
  }
  return { ...existing, policy: prev }
}

/** Same-directory temp + rename: a crash mid-write cannot leave a half config. */
export function writeConfigAtomic(configFile: string, contents: string): void {
  const dir = path.dirname(configFile)
  const tmp = path.join(dir, `.${path.basename(configFile)}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    try {
      fs.renameSync(tmp, configFile)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST')) {
        fs.rmSync(configFile, { force: true })
        fs.renameSync(tmp, configFile)
      } else {
        throw err
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* leftover tmp */ }
    throw err
  }
}

export function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactSecretFields(item))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|apikey|api_key|servicekey|service_key|dsn|url/i.test(key)) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = redactSecretFields(nested)
    }
  }
  return out
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

function requireConsoleAuth(
  sessions: ReturnType<typeof createSessionStore>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const token = process.env.CONARIUM_CONSOLE_TOKEN
    if (!token) {
      res.status(503).json({ error: 'Console auth token is not configured' })
      return
    }

    const sess = sessions.get(readCookie(req, 'conarium_console_sess'))
    if (sess) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!constantTimeEqual(req.header('x-csrf-token') || '', sess.csrf)) {
          res.status(403).json({ error: 'CSRF token required' })
          return
        }
      }
      next()
      return
    }

    const auth = req.header('authorization') || ''
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : req.header('x-conarium-console-token') || ''
    if (!constantTimeEqual(supplied, token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = process.env.CONARIUM_CONSOLE_CSRF_TOKEN || token
      if (!constantTimeEqual(req.header('x-csrf-token') || '', csrf)) {
        res.status(403).json({ error: 'CSRF token required' })
        return
      }
    }

    next()
  }
}

// A pre-chain playground file: first line parses as JSON but was written before
// entries carried hashes. A file whose entries HAVE hashes but fail validation is
// not legacy — it is a broken or tampered chain and must stay a hard error.
function isLegacyUnhashedSink(file: string): boolean {
  try {
    const first = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)[0]
    if (!first) return false
    const entry = JSON.parse(first) as Record<string, unknown>
    return typeof entry === 'object' && entry !== null && !('hash' in entry)
  } catch {
    return false
  }
}

// Playground writes go through the real hash-chained Audit — a plain appendFileSync
// entry would sit outside the chain and read as tampering. Only a positively
// identified legacy (pre-chain) file is moved aside for a clean chain; a failing
// hash/HMAC chain or an I/O error rethrows — silently starting a fresh chain would
// bury tampering evidence.
export function createPlaygroundAudit(auditFile: string): Audit {
  try {
    return new Audit({ sink: auditFile, consumer: 'Console_Playground' })
  } catch (err) {
    if (!isLegacyUnhashedSink(auditFile)) throw err
    fs.renameSync(auditFile, `${auditFile}.legacy-${Date.now()}`)
    return new Audit({ sink: auditFile, consumer: 'Console_Playground' })
  }
}

export function createConsoleApp(opts: {
  configFile?: string
  auditFile?: string
  handoff?: ReturnType<typeof createHandoffStore>
  sessions?: ReturnType<typeof createSessionStore>
  onPresence?: () => void
} = {}) {
  const app = express()
  // Limiter app basina: testler birbirinin sayacini kirletmesin.
  const limiter = new RateLimiter({ perWindow: Number(process.env.CONARIUM_CONSOLE_RATE_PER_MIN ?? 60) })
  const sweepTimer = setInterval(() => limiter.sweep(), 5 * 60_000)
  sweepTimer.unref()   // acik bir zamanlayici sureci canli tutmasin
  app.use(express.json({ limit: '64kb' }))

  const publicDir = path.join(__dirname, '../public')
  const assetsDir = path.join(__dirname, '../assets')
  const configFile = opts.configFile || path.join(__dirname, '../conarium.config.json')
  const auditFile = opts.auditFile || path.join(__dirname, '../audit.log.jsonl')
  const audit = createPlaygroundAudit(auditFile)
  const handoff = opts.handoff ?? createHandoffStore()
  const sessions = opts.sessions ?? createSessionStore()

  app.get('/handoff', (req, res) => {
    const n = String(req.query.n || '')
    if (!handoff.consume(n)) {
      res.status(403).type('text/plain').send('handoff expired or already used')
      return
    }
    const sess = sessions.create()
    res.setHeader('Set-Cookie', [
      `conarium_console_sess=${sess.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      `conarium_console_csrf=${sess.csrf}; SameSite=Strict; Path=/; Max-Age=86400`,
    ])
    res.redirect(302, '/')
  })

  if (fs.existsSync(assetsDir)) app.use('/assets', express.static(assetsDir))
  app.use(express.static(publicDir))
  // Hiz siniri KIMLIK KONTROLUNDEN ONCE.
  //
  // http.ts'te limit bilerek auth'tan SONRA kosuyor: orada amac, yetkisiz bir selin
  // gercek bir istemcinin butcesini yakmasini onlemek. Burada tehdit tam tersi —
  // konsol tek bir operator icindir ve korunmasi gereken sey TOKEN'IN KENDISI.
  // Limit auth'tan sonra kossaydi basarisiz denemeler hic sayilmaz, yani kaba
  // kuvvet denemesi sinirsiz kalirdi. Ayni kutuphane, ters sira, farkli gerekce.
  //
  // Varsayilan 60/dk: mesru bir operator konsolu bu hizda kullanmaz, kaba kuvvet
  // ise bu hizda ise yaramaz. CONARIUM_CONSOLE_RATE_PER_MIN=0 kapatir.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const client = clientKey(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? undefined)
    if (!limiter.take(client)) {
      res.status(429).set('retry-after', String(limiter.retryAfter(client))).json({ error: 'rate limit exceeded' })
      return
    }
    next()
  })
  app.use('/api', requireConsoleAuth(sessions))

  app.get('/api/presence', (_req, res) => {
    opts.onPresence?.()
    res.status(204).end()
  })

  app.get('/api/receipts', (_req, res) => {
    const loaded = loadReceiptsForConsole(configFile)
    res.json({
      chain: loaded.chain,
      items: toListItems(loaded.receipts),
      empty: loaded.emptyMessage,
    })
  })

  app.get('/api/receipts/:id/raw', (req, res) => {
    const loaded = loadReceiptsForConsole(configFile)
    const receipt = findReceipt(loaded.receipts, String(req.params.id))
    if (!receipt) {
      res.status(404).json({ error: 'receipt not found' })
      return
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${receipt.id}.json"`)
    res.send(JSON.stringify(receipt))
  })

  app.get('/api/receipts/:id/html', (req, res) => {
    const loaded = loadReceiptsForConsole(configFile)
    const receipt = findReceipt(loaded.receipts, String(req.params.id))
    if (!receipt) {
      res.status(404).type('text/plain').send('receipt not found')
      return
    }
    const html = renderReceiptHtml(
      receiptToView(receipt, {
        publicKey: publicPemForPanel(),
        verify: verifyCommandFor(loaded.sink),
        entries: loaded.receipts.length,
        chainIntegrity: loaded.chain,
        jsonHref: `/api/receipts/${encodeURIComponent(receipt.id)}/raw`,
      }),
      { mode: 'fragment' },
    )
    res.type('html').send(html)
  })

  app.get('/api/receipts/:id', (req, res) => {
    const loaded = loadReceiptsForConsole(configFile)
    const receipt = findReceipt(loaded.receipts, String(req.params.id))
    if (!receipt) {
      res.status(404).json({ error: 'receipt not found' })
      return
    }
    const html = renderReceiptHtml(
      receiptToView(receipt, {
        publicKey: publicPemForPanel(),
        verify: verifyCommandFor(loaded.sink),
        entries: loaded.receipts.length,
        chainIntegrity: loaded.chain,
        jsonHref: `/api/receipts/${encodeURIComponent(receipt.id)}/raw`,
      }),
      { mode: 'fragment' },
    )
    res.json({ receipt, html, chain: loaded.chain })
  })

  app.get('/api/config', (req, res) => {
    try {
      if (fs.existsSync(configFile)) {
        const data = fs.readFileSync(configFile, 'utf8')
        res.json(redactSecretFields(JSON.parse(data)))
      } else {
        // No invented defaults. An empty policy on screen is the truth.
        res.json({ policy: {} })
      }
    } catch {
      res.status(500).json({ error: 'Could not read config' })
    }
  })

  app.post('/api/config', (req, res) => {
    try {
      const patch = validateConsoleConfig(req.body)
      let existing: Record<string, unknown> = {}
      if (fs.existsSync(configFile)) {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      }
      const next = mergeConsolePolicyPatch(existing, patch)
      writeConfigAtomic(configFile, JSON.stringify(next, null, 2) + '\n')
      const tables = (next.policy as { allowTables?: unknown } | undefined)?.allowTables
      const allowTablesEmpty = !Array.isArray(tables) || tables.length === 0
      res.json({ success: true, allowTablesEmpty })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.get('/api/audit', (req, res) => {
    try {
      if (fs.existsSync(auditFile)) {
        const raw = fs.readFileSync(auditFile, 'utf8').trim()
        const logs = raw ? raw.split('\n').map(l => JSON.parse(l)).reverse() : []
        res.json(redactSecretFields(logs))
      } else {
        res.json([])
      }
    } catch {
      res.status(500).json({ error: 'Could not read audit logs' })
    }
  })

  app.get('/api/connectors', (req, res) => {
    res.json([
      { id: 'db-prod', type: 'PostgreSQL', status: 'connected', latency: '12ms' },
      { id: 'api-stripe', type: 'OpenAPI', status: 'connected', latency: '45ms' },
      { id: 'api-github', type: 'OpenAPI', status: 'connected', latency: '23ms' },
    ])
  })

  const sample: Record<string, Record<string, unknown>[]> = {
    customers: [
      { id: 101, name: 'John Doe', email: 'john.doe@enterprise.com', ssn: '123-45-6789', plan: 'Enterprise' },
      { id: 102, name: 'Jane Smith', email: 'jane.smith@startup.io', ssn: '987-65-4321', plan: 'Pro' },
    ],
    orders: [
      { id: 5001, customer: 'John Doe', amount: 12500, status: 'paid' },
      { id: 5002, customer: 'Jane Smith', amount: 3400, status: 'pending' },
    ],
  }

  app.post('/api/playground', (req, res) => {
    const query = String(req.body?.query || '').trim()
    let cfg = {
      maxRows: 100,
      maskColumns: ['*.email', '*.ssn', '*.tckn', '*.card', '*.phone'] as string[],
    }
    try {
      if (fs.existsSync(configFile)) {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        const pol =
          parsed?.policy && typeof parsed.policy === 'object' ? parsed.policy : parsed
        if (typeof pol?.maxRows === 'number') cfg.maxRows = pol.maxRows
        if (Array.isArray(pol?.maskColumns)) cfg.maskColumns = pol.maskColumns
      }
    } catch {}

    let decision = 'allow'
    let reason = ''
    let raw: Record<string, unknown>[] = []
    let governed: Record<string, unknown>[] = []
    let maskedCount = 0
    let table = ''

    const gov = new Governance({
      maxRows: cfg.maxRows,
      // Playground açık örnek-veri demosu: default-deny sonrası açık modu EXPLICIT belirt
      // (secrets yine denyTables ile reddedilir). Üretim yolu (index.ts) config.policy kullanır.
      allowTables: ['*'],
      denyTables: ['public.secrets'],
      maskColumns: cfg.maskColumns,
    })

    try {
      const gRes = gov.guardQuery(query)
      const match = query.match(/FROM\s+public\.([a-zA-Z0-9_]+)/i)
      table = match ? match[1].toLowerCase() : ''

      if (!sample[table]) {
        decision = 'deny'
        reason = `Unknown table "${table}". Try public.customers or public.orders.`
      } else {
        raw = sample[table]
        const dbResult = {
          rowCount: raw.length,
          fields: Object.keys(raw[0] || {}),
          rows: raw.map(r => ({ ...r, _table: `public.${table}` })),
          sql: gRes.sql,
        }
        const redacted = gov.redact(dbResult, gRes.aliases, gRes.metadata)
        governed = redacted.rows.slice(0, gov.maxRows()).map(r => {
          const out = { ...r }
          delete out._table
          return out
        })
        maskedCount = redacted.governance.maskedCount
      }
    } catch (e) {
      decision = 'deny'
      reason = (e as Error).message
    }

    const entry = audit.log({
      tool: 'query_db',
      target: table || 'n/a',
      args: { sql: query },
      rowsReturned: governed.length,
      maskedCount,
      denied: decision === 'deny',
      reason,
    })

    res.json({ decision, reason, raw, governed, maskedCount, table, audit: entry })
  })

  return app
}

export function startConsole(port: number = 3000, host: string = process.env.CONARIUM_CONSOLE_HOST || DEFAULT_CONSOLE_HOST) {
  const app = createConsoleApp()
  app.listen(port, host, () => {
    console.log(`[Conarium Console] Server started at http://${host}:${port}`)
  })
}

if (process.argv[1]?.endsWith('console.ts') || process.argv[1]?.endsWith('console.js')) {
  startConsole()
}
