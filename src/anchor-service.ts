/**
 * Hosted anchoring + countersign endpoint.
 *
 * What it does: takes a hash, countersigns the stored record with this
 * process's Ed25519 key, submits the hash to the OpenTimestamps calendars,
 * keeps the proof, and serves both forever at a stable URL. A background pass
 * stamps the log head off the request path, and upgrades that stamp from
 * `pending` to a Bitcoin block height by appending a new row — the original
 * line is never rewritten.
 *
 * What it is NOT — and this must never be blurred in the copy: Conarium is not
 * the timestamp authority. The calendars and Bitcoin are. The signature is
 * ours; the time is not. An anchoring service you have to trust for the stamp
 * would defeat the point of anchoring. The countersign is a named claim that
 * we saw this hash and wrote this record — nothing more.
 *
 * The proof is served raw at `/anchor/:id/ots`, so a third party can verify the
 * stamp with the reference OpenTimestamps client and ignore this service. The
 * public key is at `/anchor/key.pem`. The log head is at `/anchor/log/head`.
 *
 * The code is MIT like the rest — self-host it if you prefer. What is sold is
 * the key and someone else keeping the log alive.
 */
import express from 'express'
import type { Request, Response } from 'express'
import { createPublicKey, randomBytes, timingSafeEqual } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { hashPrefixToBuffer } from './anchor.js'
import { computeEntryHash, GENESIS_HASH } from './audit-hash.js'
import { isServablePublicPem, signAnchorRecord, type CountersignSig } from './anchor-sign.js'
import type { SigningKey } from './keys.js'
import { stampHash, upgradeProof } from './ots/client.js'

export type AnchorRecordType = 'submit' | 'upgrade' | 'stamp'

export interface AnchorRecord {
  type: AnchorRecordType
  id: string
  /** Customer-submitted digest (`sha256:…`). Public views expose this as `digest`. */
  digest: string
  /** Entry hash — same rule as audit-hash.ts (`hash`/`sig`/`anchor` excluded). */
  hash: string
  owner: string
  log: 'opentimestamps'
  ots: string
  state: 'pending' | 'bitcoin'
  bitcoinBlock?: number
  submittedAt: string
  upgradedAt?: string
  seq: number
  prevHash: string
  /** Set on `type: 'upgrade'` — the submit/stamp seq this row confirms. */
  upgradesSeq?: number
  /** Set on `type: 'stamp'` — the log seq whose entry hash was sent to calendars. */
  stampedSeq?: number
  sig: CountersignSig
}

export interface AnchorServiceOptions {
  /** JSONL store. Append-only: an anchoring log that can be rewritten is not one. */
  storePath: string
  /** token -> owner id. Anonymous writes would let anyone fill the disk. */
  tokens: Map<string, string>
  /** Public base URL, used to build the permanent verification address. */
  publicBaseUrl: string
  /** Required. A countersign service that can start without a key is not one. */
  signingKey: SigningKey
  /** Override the derived public PEM (tests). Still refused if it looks private. */
  publicPem?: string
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

/** Reads every record. Does not validate the chain — use readLiveStore. */
export function readStore(path: string): AnchorRecord[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AnchorRecord)
}

export function validateAnchorLog(rows: AnchorRecord[]): void {
  let previous = GENESIS_HASH
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!Number.isInteger(row.seq) || row.seq !== i + 1) {
      throw new Error(`anchor log corrupt: seq at index ${i}`)
    }
    if (row.prevHash !== previous) {
      throw new Error('anchor log corrupt: prevHash mismatch')
    }
    if (!row.hash) {
      throw new Error('anchor log corrupt: missing entry hash')
    }
    const expected = computeEntryHash(row as unknown as Record<string, unknown>)
    if (row.hash !== expected) {
      throw new Error('anchor log corrupt: entry hash mismatch')
    }
    previous = row.hash
  }
}

export function readLiveStore(path: string): AnchorRecord[] {
  const rows = readStore(path)
  validateAnchorLog(rows)
  return rows
}

export interface InclusionLink {
  seq: number
  hash: string
  prevHash: string
}

export interface InclusionProof {
  seq: number
  hash: string
  prevHash: string
  head: {
    seq: number
    hash: string
    state: 'pending' | 'bitcoin'
    bitcoinBlock?: number
  }
  path: InclusionLink[]
}

export function buildInclusionProof(rows: AnchorRecord[], target: AnchorRecord): InclusionProof {
  if (!Number.isInteger(target.seq) || target.seq < 1 || target.seq > rows.length) {
    throw new Error('cannot build inclusion proof: record not in log')
  }
  const at = rows[target.seq - 1]
  if (at.hash !== target.hash || at.seq !== target.seq) {
    throw new Error('cannot build inclusion proof: record moved')
  }
  const head = rows[rows.length - 1]
  return {
    seq: target.seq,
    hash: target.hash,
    prevHash: target.prevHash,
    head: {
      seq: head.seq,
      hash: head.hash,
      state: head.state,
      ...(head.bitcoinBlock !== undefined ? { bitcoinBlock: head.bitcoinBlock } : {}),
    },
    path: rows.slice(target.seq - 1).map((r) => ({
      seq: r.seq,
      hash: r.hash,
      prevHash: r.prevHash,
    })),
  }
}

export function verifyInclusionProof(
  record: { seq: number; hash: string; prevHash: string },
  proof: InclusionProof,
): boolean {
  if (proof.seq !== record.seq || proof.hash !== record.hash || proof.prevHash !== record.prevHash) {
    return false
  }
  if (proof.path.length === 0) return false
  if (proof.path[0].hash !== record.hash || proof.path[0].seq !== record.seq) return false
  let prev = record.prevHash
  for (const step of proof.path) {
    if (step.prevHash !== prev) return false
    prev = step.hash
  }
  const last = proof.path[proof.path.length - 1]
  return last.hash === proof.head.hash && last.seq === proof.head.seq
}

function nextLink(rows: AnchorRecord[]): { seq: number; prevHash: string } {
  if (rows.length === 0) return { seq: 1, prevHash: GENESIS_HASH }
  const last = rows[rows.length - 1]
  return { seq: last.seq + 1, prevHash: last.hash }
}

function sealRecord(unsigned: Omit<AnchorRecord, 'hash' | 'sig'>, key: SigningKey): AnchorRecord {
  const hashed = {
    ...unsigned,
    hash: computeEntryHash(unsigned as unknown as Record<string, unknown>),
  }
  return signAnchorRecord(hashed, key)
}

function findSubmit(rows: AnchorRecord[], id: string): AnchorRecord | undefined {
  return rows.find((r) => r.id === id && r.type === 'submit')
}

function latestView(rows: AnchorRecord[], submit: AnchorRecord): AnchorRecord {
  const upgrades = rows.filter((r) => r.type === 'upgrade' && r.upgradesSeq === submit.seq)
  if (upgrades.length === 0) return submit
  const last = upgrades[upgrades.length - 1]
  return { ...last, id: submit.id, digest: submit.digest }
}

function alreadyUpgraded(rows: AnchorRecord[], seq: number): boolean {
  return rows.some((r) => r.type === 'upgrade' && r.upgradesSeq === seq)
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
  if (!opts.signingKey) {
    throw new Error(
      'createAnchorService: signingKey is required — a countersign service without a key is not one',
    )
  }
  const stamp = opts.stamp ?? defaultStamp
  const upgrade = opts.upgrade ?? defaultUpgrade
  const perMinute = opts.submitsPerMinute ?? 60
  const base = opts.publicBaseUrl.replace(/\/+$/, '')
  const publicPem =
    opts.publicPem ??
    createPublicKey(opts.signingKey.privateKey).export({ type: 'spki', format: 'pem' }).toString()

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

  function live(res: Response): AnchorRecord[] | null {
    try {
      return readLiveStore(opts.storePath)
    } catch {
      res.status(503).json({ error: 'anchor log corrupt' })
      return null
    }
  }

  app.get('/healthz', (_req, res) => {
    const rows = live(res)
    if (!rows) return
    res.json({
      ok: true,
      service: 'conarium-anchor',
      anchors: rows.filter((r) => r.type === 'submit').length,
    })
  })

  // `/anchor` is where a curious visitor types first, and it only accepted POST,
  // so a browser got Express's default "Cannot GET /anchor" with <title>Error</title>.
  // Every other surface in this product explains itself; the front door of the
  // countersigning service should not be the one that looks broken.
  app.get(['/anchor', '/anchor/'], (req, res) => {
    const index = {
      service: 'conarium-countersign',
      keyId: opts.signingKey.keyId,
      publicKey: `${base}/anchor/key.pem`,
      keyIdSidecar: `${base}/anchor/key.pem.keyid`,
      logHead: `${base}/anchor/log/head`,
      record: `${base}/anchor/<id>`,
      submit: {
        method: 'POST',
        path: '/anchor',
        auth: 'Authorization: Bearer <token>',
        body: { hash: 'sha256:<64 hex>' },
        note: 'A digest and nothing else. No content is sent to this service and none is stored.',
      },
      verify: `npx conarium-countersign-verify record.json --pubkey key.pem --log-url ${base}/anchor/<id>`,
      claim:
        'A countersignature says a signer other than you saw this digest at this time and placed it at this position in a log that is appended to, never rewritten.',
      limits: [
        'It does not say your records were correct when they were written.',
        'It is not a claim that the countersigner is honest — only that this log cannot be quietly rearranged afterwards.',
        'If the signing key leaks, every signature under this keyId is worthless and there is no recall.',
      ],
    }
    res.setHeader('Vary', 'Accept')
    if (req.accepts(['json', 'html']) === 'html') {
      res.type('html').send(indexPage(index))
      return
    }
    res.json(index)
  })

  // Registered before /anchor/:id so these paths are never treated as an id.
  app.get('/anchor/key.pem', (_req, res) => {
    if (!isServablePublicPem(publicPem)) {
      res.status(403).type('text/plain').send('refusing to serve a private key')
      return
    }
    res.type('application/x-pem-file').send(publicPem)
  })

  app.get('/anchor/key.pem.keyid', (_req, res) => {
    res.type('text/plain').send(opts.signingKey.keyId + '\n')
  })

  app.get('/anchor/log/head', (_req, res) => {
    const rows = live(res)
    if (!rows) return
    if (rows.length === 0) {
      res.json({ seq: 0, hash: GENESIS_HASH, prevHash: GENESIS_HASH, empty: true })
      return
    }
    const head = rows[rows.length - 1]
    res.json({
      seq: head.seq,
      hash: head.hash,
      prevHash: head.prevHash,
      type: head.type,
      state: head.state,
      ...(head.bitcoinBlock !== undefined ? { bitcoinBlock: head.bitcoinBlock } : {}),
    })
  })

  app.post('/anchor', async (req, res) => {
    const owner = auth(req, res)
    if (!owner) return

    const hash = typeof req.body?.hash === 'string' ? req.body.hash : ''
    try {
      hashPrefixToBuffer(hash)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
      return
    }

    if (overLimit(owner)) {
      res.status(429).json({ error: 'rate limit exceeded', retryAfterSeconds: 60 })
      return
    }

    const rows = live(res)
    if (!rows) return

    // Same content, same owner, same answer. Re-anchoring an identical hash
    // wastes a calendar submission and produces a second id for one fact.
    const existing = rows.find((r) => r.type === 'submit' && r.digest === hash && r.owner === owner)
    if (existing) {
      res.status(200).json({
        ...publicView(latestView(rows, existing), base, rows, existing),
        countersign: existing,
        deduplicated: true,
      })
      return
    }

    // Stamp is off the request path (C5). A slow calendar must not lock accept.
    const link = nextLink(rows)
    const record = sealRecord(
      {
        type: 'submit',
        id: randomBytes(9).toString('base64url'),
        digest: hash,
        owner,
        log: 'opentimestamps',
        ots: '',
        state: 'pending',
        submittedAt: new Date().toISOString(),
        seq: link.seq,
        prevHash: link.prevHash,
      },
      opts.signingKey,
    )
    appendFileSync(opts.storePath, JSON.stringify(record) + '\n')
    res.status(201).json({ ...publicView(record, base, [...rows, record]), countersign: record })
  })

  app.get('/anchor/:id', (req, res) => {
    const rows = live(res)
    if (!rows) return
    const submit = findSubmit(rows, req.params.id)
    if (!submit) {
      res.status(404).json({ error: 'no such anchor' })
      return
    }
    const record = latestView(rows, submit)
    // Public on purpose: a verification URL only a token holder can open is not
    // a verification URL. It carries a hash and a proof, never content.
    res.setHeader('Vary', 'Accept')
    try {
      if (req.accepts(['json', 'html']) === 'html') {
        res.type('html').send(humanPage(record, base, rows, submit))
        return
      }
      res.json(publicView(record, base, rows, submit))
    } catch (err) {
      // Only an actual proof failure may be reported as one. This catch used to
      // label every error "cannot build inclusion proof", so a rendering bug
      // sent whoever was debugging it to the log instead of to the renderer.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('cannot build inclusion proof')) {
        res.status(503).json({ error: 'cannot build inclusion proof' })
        return
      }
      res.status(500).json({ error: 'internal error while rendering this record' })
    }
  })

  app.get('/anchor/:id/ots', (req, res) => {
    const rows = live(res)
    if (!rows) return
    const submit = findSubmit(rows, req.params.id)
    if (!submit) {
      res.status(404).json({ error: 'no such anchor' })
      return
    }
    const stampRow = rows.find((r) => r.type === 'stamp' && (r.stampedSeq ?? 0) >= submit.seq)
    if (!stampRow || !stampRow.ots) {
      res.status(404).json({ error: 'not yet stamped — wait for the next head stamp' })
      return
    }
    const record = latestView(rows, stampRow)
    res.type('application/octet-stream').send(Buffer.from(record.ots, 'base64'))
  })

  /** Upgrade pass. Idempotent, safe to run from cron as often as you like. */
  app.post('/upgrade', async (req, res) => {
    const owner = auth(req, res)
    if (!owner) return
    try {
      const result = await runUpgrade()
      res.json(result)
    } catch {
      res.status(503).json({ error: 'anchor log corrupt' })
    }
  })

  async function runStamp(): Promise<{ attempted: number; stamped: number }> {
    const rows = readLiveStore(opts.storePath)
    if (rows.length === 0) return { attempted: 0, stamped: 0 }
    const head = rows[rows.length - 1]
    if (head.type === 'stamp') return { attempted: 0, stamped: 0 }
    if (rows.some((r) => r.type === 'stamp' && r.stampedSeq === head.seq)) {
      return { attempted: 0, stamped: 0 }
    }
    try {
      const ots = await stamp(hashPrefixToBuffer(`sha256:${head.hash}`))
      const link = nextLink(rows)
      const next = sealRecord(
        {
          type: 'stamp',
          id: randomBytes(9).toString('base64url'),
          digest: `sha256:${head.hash}`,
          owner: 'conarium',
          log: 'opentimestamps',
          ots,
          state: 'pending',
          submittedAt: new Date().toISOString(),
          seq: link.seq,
          prevHash: link.prevHash,
          stampedSeq: head.seq,
        },
        opts.signingKey,
      )
      appendFileSync(opts.storePath, JSON.stringify(next) + '\n')
      return { attempted: 1, stamped: 1 }
    } catch (err) {
      // The C5 contract holds: a dead calendar never turns a submit into a 5xx,
      // and the next tick retries. But swallowing the reason meant an operator
      // whose stamping had been failing for weeks saw only endless 404s on
      // GET /:id/ots, with nothing in stderr to say why. Say why.
      console.error(
        `[conarium-anchor] head stamp failed, will retry next tick: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { attempted: 1, stamped: 0 }
    }
  }

  async function runUpgrade(): Promise<{ checked: number; upgraded: number }> {
    const rows = readLiveStore(opts.storePath)
    let upgraded = 0
    let checked = 0
    for (const row of rows) {
      if (row.type !== 'stamp' || row.state !== 'pending') continue
      if (alreadyUpgraded(rows, row.seq)) continue
      if (!row.ots) continue
      checked += 1
      try {
        const out = await upgrade(row.ots)
        if (out.upgraded) {
          const link = nextLink(rows)
          const unsigned: Omit<AnchorRecord, 'hash' | 'sig'> = {
            type: 'upgrade',
            id: randomBytes(9).toString('base64url'),
            digest: row.digest,
            owner: row.owner,
            log: row.log,
            ots: out.ots ?? row.ots,
            state: 'bitcoin',
            submittedAt: row.submittedAt,
            upgradedAt: new Date().toISOString(),
            seq: link.seq,
            prevHash: link.prevHash,
            upgradesSeq: row.seq,
          }
          if (typeof out.block === 'number') unsigned.bitcoinBlock = out.block
          const next = sealRecord(unsigned, opts.signingKey)
          appendFileSync(opts.storePath, JSON.stringify(next) + '\n')
          rows.push(next)
          upgraded += 1
        }
      } catch {
        // A calendar being unreachable is not a reason to lose the record.
        // It stays pending and the next pass tries again.
      }
    }
    return { checked, upgraded }
  }

  return { app, runUpgrade, runStamp, readStore: () => readStore(opts.storePath) }
}

function publicView(r: AnchorRecord, base: string, rows?: AnchorRecord[], target?: AnchorRecord) {
  const inclusion = rows ? buildInclusionProof(rows, target ?? r) : undefined
  return {
    id: r.id,
    // `digest` is what the customer submitted; `chainHash` is this record's link
    // in our log. Both used to be reachable as "hash" in one document — the
    // top-level field held the customer digest while inclusion.hash held the
    // chain hash, so the same name carried two different values next to a
    // prevHash that chains only one of them. In an evidence product that
    // ambiguity is not a style question.
    digest: r.digest,
    chainHash: r.hash,
    log: r.log,
    state: r.state,
    seq: r.seq,
    prevHash: r.prevHash,
    ...(r.bitcoinBlock !== undefined ? { bitcoinBlock: r.bitcoinBlock } : {}),
    submittedAt: r.submittedAt,
    ...(r.upgradedAt ? { upgradedAt: r.upgradedAt } : {}),
    sig: r.sig,
    ...(inclusion ? { inclusion } : {}),
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

function indexPage(i: {
  keyId: string
  publicKey: string
  logHead: string
  verify: string
  claim: string
  limits: string[]
  submit: { method: string; path: string; auth: string; body: { hash: string } }
}): string {
  return `<!doctype html><meta charset="utf-8"><title>Conarium countersigning</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.3rem">Conarium countersigning</h1>
<p>${esc(i.claim)}</p>
<table style="border-collapse:collapse">
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">key id</td><td><code>${esc(i.keyId)}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">public key</td><td><a href="${esc(i.publicKey)}"><code>${esc(i.publicKey)}</code></a></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">log head</td><td><a href="${esc(i.logHead)}"><code>${esc(i.logHead)}</code></a></td></tr>
</table>
<h2 style="font-size:1rem;margin-top:2rem">Submit a chain head</h2>
<pre style="background:#f5f5f5;padding:.8rem;overflow-x:auto"><code>${esc(i.submit.method)} ${esc(i.submit.path)}
${esc(i.submit.auth)}
${esc(JSON.stringify(i.submit.body))}</code></pre>
<p style="opacity:.75">A digest and nothing else. No content is sent to this service and none is stored.</p>
<h2 style="font-size:1rem;margin-top:2rem">Verify one you were given</h2>
<pre style="background:#f5f5f5;padding:.8rem;overflow-x:auto"><code>${esc(i.verify)}</code></pre>
<h2 style="font-size:1rem;margin-top:2rem">What this does not say</h2>
<ul>${i.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</body>`
}

function humanPage(r: AnchorRecord, base: string, rows?: AnchorRecord[], target?: AnchorRecord): string {
  const v = publicView(r, base, rows, target)
  const proof = v.inclusion
  const incl = proof
    ? `<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">inclusion</td><td><code>seq ${proof.seq} → head ${proof.head.seq} (${esc(proof.head.state)})</code></td></tr>`
    : ''
  return `<!doctype html><meta charset="utf-8"><title>Conarium anchor ${esc(r.id)}</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.3rem">Anchor ${esc(r.id)}</h1>
<table style="border-collapse:collapse">
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">submitted digest</td><td><code>${esc(v.digest)}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">chain hash</td><td><code>${esc(v.chainHash)}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">seq</td><td><code>${r.seq}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">state</td><td><code>${esc(r.state)}</code></td></tr>
${r.bitcoinBlock !== undefined ? `<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">bitcoin block</td><td><code>${r.bitcoinBlock}</code></td></tr>` : ''}
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">submitted</td><td><code>${esc(r.submittedAt)}</code></td></tr>
<tr><td style="padding:.3rem 1rem .3rem 0;opacity:.7">countersign</td><td><code>Ed25519 ${esc(r.sig.keyId)}</code></td></tr>
${incl}
</table>
<p>${esc(v.claim)}</p>
<p>Raw proof: <a href="${esc(v.verify)}">${esc(v.verify)}</a> — verify it with the reference
OpenTimestamps client if you would rather not take our word for anything.</p>
</body>`
}
