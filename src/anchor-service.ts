/**
 * Hosted anchoring endpoint.
 *
 * What it does: takes a hash, submits it to the OpenTimestamps calendars, keeps
 * the resulting proof, and serves it forever at a stable URL. A background pass
 * upgrades each proof from `pending` to a Bitcoin block height once the block
 * lands.
 *
 * What it is NOT — and this must never be blurred in the copy: Conarium is not
 * the timestamp authority. The calendars and Bitcoin are. This service is
 * retention, a permanent public address, and the upgrade job nobody remembers
 * to run. It sells convenience and durability, never trust.
 *
 * The proof is served raw at `/anchor/:id/ots`, so a third party can verify with
 * the reference OpenTimestamps client and ignore this service entirely. An
 * anchoring service you have to trust would defeat the point of anchoring.
 *
 * The code is MIT like the rest — self-host it if you prefer. What is sold is
 * someone else keeping it alive.
 */
import express from 'express'
import type { Request, Response } from 'express'
import { randomBytes, timingSafeEqual } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { hashPrefixToBuffer } from './anchor.js'
import { stampHash, upgradeProof } from './ots/client.js'

export interface AnchorRecord {
  id: string
  hash: string
  owner: string
  log: 'opentimestamps'
  ots: string
  state: 'pending' | 'bitcoin'
  bitcoinBlock?: number
  submittedAt: string
  upgradedAt?: string
}

export interface AnchorServiceOptions {
  /** JSONL store. Append-only: an anchoring log that can be rewritten is not one. */
  storePath: string
  /** token -> owner id. Anonymous writes would let anyone fill the disk. */
  tokens: Map<string, string>
  /** Public base URL, used to build the permanent verification address. */
  publicBaseUrl: string
  submitsPerMinute?: number
  /** Injected in tests so the suite never touches a calendar server. */
  stamp?: (digest: Buffer) => Promise<string>
  upgrade?: (otsBase64: string) => Promise<{ upgraded: boolean; block?: number; ots?: string }>
}

// Matches conarium-stamp. One slow calendar out of four is normal; 20s was not
// enough in practice and produced a 502 for a submission that would have landed.
const OTS_TIMEOUT_MS = 30_000

async function defaultStamp(digest: Buffer): Promise<string> {
  const otsBytes = await Promise.race([
    stampHash(digest, { timeoutMs: OTS_TIMEOUT_MS }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`stamp timed out after ${OTS_TIMEOUT_MS}ms`)), OTS_TIMEOUT_MS),
    ),
  ])
  return otsBytes.toString('base64')
}

async function defaultUpgrade(otsBase64: string): Promise<{ upgraded: boolean; block?: number; ots?: string }> {
  const up = await upgradeProof(Buffer.from(otsBase64, 'base64'))
  if (!up.changed) return { upgraded: false }
  return {
    upgraded: true,
    block: up.bitcoinBlock ?? undefined,
    ots: up.otsBytes.toString('base64'),
  }
}

/** Reads every record. The store is small by design — one line per anchor. */
export function readStore(path: string): AnchorRecord[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AnchorRecord)
}

/**
 * An upgrade is the one legitimate reason to rewrite a line, so the whole file
 * is rewritten rather than appended to. Everything else is append-only.
 */
function rewriteStore(path: string, rows: AnchorRecord[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

export function loadTokensFile(path: string): Map<string, string> {
  const tokens = new Map<string, string>()
  if (!existsSync(path)) return tokens
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>
  for (const [token, owner] of Object.entries(parsed)) {
    if (typeof token === 'string' && typeof owner === 'string' && token && owner) {
      tokens.set(token, owner)
    }
  }
  return tokens
}

/** Constant-time lookup: a token map compared with === leaks length by timing. */
function resolveOwner(tokens: Map<string, string>, presented: string): string | null {
  const presentedBuf = Buffer.from(presented)
  let found: string | null = null
  for (const [token, owner] of tokens) {
    const known = Buffer.from(token)
    if (known.length === presentedBuf.length && timingSafeEqual(known, presentedBuf)) found = owner
  }
  return found
}

export function createAnchorService(opts: AnchorServiceOptions) {
  const stamp = opts.stamp ?? defaultStamp
  const upgrade = opts.upgrade ?? defaultUpgrade
  const perMinute = opts.submitsPerMinute ?? 60
  const base = opts.publicBaseUrl.replace(/\/+$/, '')

  mkdirSync(dirname(opts.storePath), { recursive: true })

  const buckets = new Map<string, { count: number; resetAt: number }>()
  function overLimit(owner: string): boolean {
    const now = Date.now()
    const b = buckets.get(owner)
    if (!b || now >= b.resetAt) {
      buckets.set(owner, { count: 1, resetAt: now + 60_000 })
      return false
    }
    b.count += 1
    return b.count > perMinute
  }

  const app = express()
  app.use(express.json({ limit: '16kb' }))

  function auth(req: Request, res: Response): string | null {
    const header = req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) {
      res.status(401).json({ error: 'missing bearer token' })
      return null
    }
    const owner = resolveOwner(opts.tokens, token)
    if (!owner) {
      res.status(401).json({ error: 'unknown token' })
      return null
    }
    return owner
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'conarium-anchor', anchors: readStore(opts.storePath).length })
  })

  app.post('/anchor', async (req, res) => {
    const owner = auth(req, res)
    if (!owner) return

    const hash = typeof req.body?.hash === 'string' ? req.body.hash : ''
    let digest: Buffer
    try {
      digest = hashPrefixToBuffer(hash)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
      return
    }

    if (overLimit(owner)) {
      res.status(429).json({ error: 'rate limit exceeded', retryAfterSeconds: 60 })
      return
    }

    // Same content, same owner, same answer. Re-anchoring an identical hash
    // wastes a calendar submission and produces a second id for one fact.
    const existing = readStore(opts.storePath).find((r) => r.hash === hash && r.owner === owner)
    if (existing) {
      res.status(200).json({ ...publicView(existing, base), deduplicated: true })
      return
    }

    let ots: string
    try {
      ots = await stamp(digest)
    } catch (err) {
      // Fail loudly. A silent 200 here would mean the customer believes their
      // chain is anchored when nothing was submitted.
      res.status(502).json({ error: `calendar submission failed: ${(err as Error).message}` })
      return
    }

    const record: AnchorRecord = {
      id: randomBytes(9).toString('base64url'),
      hash,
      owner,
      log: 'opentimestamps',
      ots,
      state: 'pending',
      submittedAt: new Date().toISOString(),
    }
    appendFileSync(opts.storePath, JSON.stringify(record) + '\n')
    res.status(201).json(publicView(record, base))
  })

  app.get('/anchor/:id', (req, res) => {
    const record = readStore(opts.storePath).find((r) => r.id === req.params.id)
    if (!record) {
      res.status(404).json({ error: 'no such anchor' })
      return
    }
    // Public on purpose: a verification URL only a token holder can open is not
    // a verification URL. It carries a hash and a proof, never content.
    res.setHeader('Vary', 'Accept')
    if (req.accepts(['json', 'html']) === 'html') {
      res.type('html').send(humanPage(record, base))
      return
    }
    res.json(publicView(record, base))
  })

  app.get('/anchor/:id/ots', (req, res) => {
    const record = readStore(opts.storePath).find((r) => r.id === req.params.id)
    if (!record) {
      res.status(404).json({ error: 'no such anchor' })
      return
    }
    res.type('application/octet-stream').send(Buffer.from(record.ots, 'base64'))
  })

  /** Upgrade pass. Idempotent, safe to run from cron as often as you like. */
  app.post('/upgrade', async (req, res) => {
    const owner = auth(req, res)
    if (!owner) return
    const result = await runUpgrade()
    res.json(result)
  })

  async function runUpgrade(): Promise<{ checked: number; upgraded: number }> {
    const rows = readStore(opts.storePath)
    let upgraded = 0
    let checked = 0
    for (const row of rows) {
      if (row.state !== 'pending') continue
      checked += 1
      try {
        const out = await upgrade(row.ots)
        if (out.upgraded) {
          row.state = 'bitcoin'
          row.ots = out.ots ?? row.ots
          if (typeof out.block === 'number') row.bitcoinBlock = out.block
          row.upgradedAt = new Date().toISOString()
          upgraded += 1
        }
      } catch {
        // A calendar being unreachable is not a reason to lose the record.
        // It stays pending and the next pass tries again.
      }
    }
    if (upgraded) rewriteStore(opts.storePath, rows)
    return { checked, upgraded }
  }

  return { app, runUpgrade, readStore: () => readStore(opts.storePath) }
}

function publicView(r: AnchorRecord, base: string) {
  return {
    id: r.id,
    hash: r.hash,
    log: r.log,
    state: r.state,
    ...(r.bitcoinBlock !== undefined ? { bitcoinBlock: r.bitcoinBlock } : {}),
    submittedAt: r.submittedAt,
    ...(r.upgradedAt ? { upgradedAt: r.upgradedAt } : {}),
    verify: `${base}/anchor/${r.id}/ots`,
    claim:
      r.state === 'bitcoin'
        ? 'This hash existed no later than the Bitcoin block below. Conarium is not the time source — the OpenTimestamps calendars and Bitcoin are, and the proof above can be checked without us.'
        : 'Submitted to the OpenTimestamps calendars. Until a Bitcoin block confirms it, this is a calendar promise and nothing stronger.',
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function humanPage(r: AnchorRecord, base: string): string {
  const v = publicView(r, base)
  return `<!doctype html><meta charset="utf-8"><title>Conarium anchor ${esc(r.id)}</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.3rem">Anchor ${esc(r.id)}</h1>
<table style="border-collapse:collapse">
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">hash</td><td><code>${esc(r.hash)}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">state</td><td><code>${esc(r.state)}</code></td></tr>
${r.bitcoinBlock !== undefined ? `<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">bitcoin block</td><td><code>${r.bitcoinBlock}</code></td></tr>` : ''}
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">submitted</td><td><code>${esc(r.submittedAt)}</code></td></tr>
</table>
<p>${esc(v.claim)}</p>
<p>Raw proof: <a href="${esc(v.verify)}">${esc(v.verify)}</a> — verify it with the reference
OpenTimestamps client if you would rather not take our word for anything.</p>
</body>`
}
