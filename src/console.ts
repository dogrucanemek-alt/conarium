import express, { type NextFunction, type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { Governance } from './governance.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const DEFAULT_CONSOLE_HOST = '127.0.0.1'

const ConsoleConfigSchema = z.object({
  maxRows: z.number().int().positive().max(10000).default(100),
  allowTools: z.array(z.string()).default(['*']),
  denyTools: z.array(z.string()).default([]),
  piiMasking: z.boolean().default(true),
}).strict()

type ConsoleConfig = z.infer<typeof ConsoleConfigSchema>

export function validateConsoleConfig(input: unknown): ConsoleConfig {
  return ConsoleConfigSchema.parse(input)
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

function requireConsoleAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.CONARIUM_CONSOLE_TOKEN
  if (!token) {
    res.status(503).json({ error: 'Console auth token is not configured' })
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

export function createConsoleApp(opts: { configFile?: string; auditFile?: string } = {}) {
  const app = express()
  app.use(express.json({ limit: '64kb' }))

  const publicDir = path.join(__dirname, '../public')
  const configFile = opts.configFile || path.join(__dirname, '../conarium.config.json')
  const auditFile = opts.auditFile || path.join(__dirname, '../audit.log.jsonl')

  app.use(express.static(publicDir))
  app.use('/api', requireConsoleAuth)

  app.get('/api/config', (req, res) => {
    try {
      if (fs.existsSync(configFile)) {
        const data = fs.readFileSync(configFile, 'utf8')
        res.json(redactSecretFields(JSON.parse(data)))
      } else {
        res.json({ maxRows: 100, allowTools: ['*'], denyTools: ['delete*'], piiMasking: true })
      }
    } catch {
      res.status(500).json({ error: 'Could not read config' })
    }
  })

  app.post('/api/config', (req, res) => {
    try {
      const newConfig = validateConsoleConfig(req.body)
      fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2))
      res.json({ success: true })
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
    let cfg: ConsoleConfig = { maxRows: 100, allowTools: ['*'], denyTools: [], piiMasking: true }
    try {
      if (fs.existsSync(configFile)) cfg = validateConsoleConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')))
    } catch {}

    let decision = 'allow'
    let reason = ''
    let raw: Record<string, unknown>[] = []
    let governed: Record<string, unknown>[] = []
    let maskedCount = 0
    let table = ''

    const gov = new Governance({
      maxRows: cfg.maxRows,
      denyTables: ['public.secrets'],
      maskColumns: cfg.piiMasking !== false ? ['*.email', '*.ssn', '*.tckn', '*.card', '*.phone'] : [],
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

    const entry = {
      timestamp: new Date().toISOString(),
      actor: 'Console_Playground',
      tool: 'query_db',
      target: table || 'n/a',
      args: { sql: query },
      rowsReturned: governed.length,
      maskedCount,
      denied: decision === 'deny',
      reason,
    }
    try { fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n') } catch {}

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
