import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPrivateKey, createPublicKey } from 'crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import request from 'supertest'
import { createAnchorService, validateAnchorLog, verifyInclusionProof } from './anchor-service.js'
import { GENESIS_HASH } from './audit-hash.js'
import { verifyAnchorRecord } from './anchor-sign.js'
import { generateKeyPair, type SigningKey, type VerifyKey } from './keys.js'

const HASH = 'sha256:' + 'ab'.repeat(32)
const HASH2 = 'sha256:' + 'cd'.repeat(32)

let dir: string
let signing: SigningKey
let verify: VerifyKey
let publicPem: string
let privatePem: string

function makeKey() {
  const pair = generateKeyPair('test-anchor-key')
  return {
    signing: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) } satisfies SigningKey,
    verify: { keyId: pair.keyId, publicKey: createPublicKey(pair.publicPem) } satisfies VerifyKey,
    publicPem: pair.publicPem,
    privatePem: pair.privatePem,
  }
}

function svc(over: Partial<Parameters<typeof createAnchorService>[0]> = {}) {
  return createAnchorService({
    storePath: join(dir, 'anchors.jsonl'),
    tokens: new Map([['tok-a', 'acme'], ['tok-b', 'globex']]),
    publicBaseUrl: 'https://anchor.example/',
    signingKey: signing,
    stamp: async () => Buffer.from('fake-ots-proof').toString('base64'),
    upgrade: async () => ({ upgraded: true, block: 961333, ots: Buffer.from('upgraded').toString('base64') }),
    ...over,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anchor-svc-'))
  const k = makeKey()
  signing = k.signing
  verify = k.verify
  publicPem = k.publicPem
  privatePem = k.privatePem
})

describe('anchor service', () => {
  it('rejects anonymous and unknown tokens', async () => {
    const { app } = svc()
    expect((await request(app).post('/anchor').send({ hash: HASH })).status).toBe(401)
    expect(
      (await request(app).post('/anchor').set('authorization', 'Bearer nope').send({ hash: HASH })).status,
    ).toBe(401)
  })

  it('rejects a malformed hash before touching a calendar', async () => {
    let calls = 0
    const { app } = svc({
      stamp: async () => {
        calls += 1
        return 'x'
      },
    })
    const res = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: 'not-a-hash' })
    expect(res.status).toBe(400)
    expect(calls).toBe(0)
  })

  it('countersigns each accepted submit with Ed25519 (C1)', async () => {
    const { app, readStore } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(created.status).toBe(201)
    expect(created.body.sig).toEqual({
      alg: 'Ed25519',
      keyId: 'test-anchor-key',
      value: expect.any(String),
    })

    const rec = readStore()[0]
    expect(rec.digest).toBe(HASH)
    expect(rec.seq).toBe(1)
    expect(rec.prevHash).toBe(GENESIS_HASH)
    expect(verifyAnchorRecord(rec as unknown as Record<string, unknown>, verify)).toBe(true)

    const pem = await request(app).get('/anchor/key.pem')
    expect(pem.status).toBe(200)
    expect(pem.text).toBe(publicPem)
    expect(pem.text).toContain('BEGIN PUBLIC KEY')
    expect(pem.text).not.toMatch(/PRIVATE KEY/)

    const keyId = await request(app).get('/anchor/key.pem.keyid')
    expect(keyId.status).toBe(200)
    expect(keyId.text.trim()).toBe('test-anchor-key')

    const mutated = { ...rec, hash: rec.hash.slice(0, -1) + (rec.hash.endsWith('a') ? 'b' : 'a') }
    expect(verifyAnchorRecord(mutated as unknown as Record<string, unknown>, verify)).toBe(false)
  })

  it('refuses to construct without a signing key', () => {
    expect(() =>
      createAnchorService({
        storePath: join(dir, 'anchors.jsonl'),
        tokens: new Map([['tok-a', 'acme']]),
        publicBaseUrl: 'https://anchor.example/',
        signingKey: undefined as unknown as SigningKey,
        stamp: async () => 'x',
      }),
    ).toThrow(/signingKey is required/)
  })

  it('refuses to serve a private PEM at /anchor/key.pem', async () => {
    const { app } = svc({ publicPem: privatePem })
    const res = await request(app).get('/anchor/key.pem')
    expect(res.status).toBe(403)
    expect(res.text).toMatch(/private key/)
  })

  it('anchors a hash and serves it at a permanent url', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(created.status).toBe(201)
    expect(created.body.state).toBe('pending')
    expect(created.body.verify).toBe(`https://anchor.example/anchor/${created.body.id}/ots`)
    // The pending claim must not sound like a Bitcoin confirmation.
    expect(created.body.claim).toMatch(/calendar promise/)

    const fetched = await request(app).get(`/anchor/${created.body.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.digest).toBe(HASH)
  })

  it('never returns the owner or the token in a public view', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const body = JSON.stringify((await request(app).get(`/anchor/${created.body.id}`)).body)
    expect(body).not.toContain('acme')
    expect(body).not.toContain('tok-a')
  })

  it('stamps the log head once, not every submit (C5)', async () => {
    let calls = 0
    const { app, runStamp } = svc({
      stamp: async () => {
        calls += 1
        return Buffer.from('head-ots').toString('base64')
      },
    })
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })).status).toBe(201)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH2 })).status).toBe(201)
    expect(calls).toBe(0)
    // RED 2026-08-15: every POST hits the calendars. N submits must be 1 stamp.
    const tick = await runStamp()
    expect(tick).toEqual({ attempted: 1, stamped: 1 })
    expect(calls).toBe(1)
  })

  it('accepts a submit when the calendar is down and stamps on the next tick', async () => {
    const { app, runStamp, readStore } = svc({
      stamp: async () => {
        throw new Error('calendars unreachable')
      },
    })
    const res = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(res.status).toBe(201)
    expect(readStore()).toHaveLength(1)
    // The failure must reach stderr: an operator whose stamping has been broken
    // for weeks otherwise sees only endless 404s on /:id/ots, with no cause.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runStamp()).toEqual({ attempted: 1, stamped: 0 })
      expect(err).toHaveBeenCalledWith(expect.stringContaining('calendars unreachable'))
    } finally {
      err.mockRestore()
    }
    expect(readStore()).toHaveLength(1)
  })

  it('deduplicates the same hash for the same owner, but not across owners', async () => {
    const { app } = svc()
    const a1 = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const a2 = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(a2.body.id).toBe(a1.body.id)
    expect(a2.body.deduplicated).toBe(true)

    const b1 = await request(app).post('/anchor').set('authorization', 'Bearer tok-b').send({ hash: HASH })
    expect(b1.body.id).not.toBe(a1.body.id)
  })

  it('enforces the per-owner rate limit without blocking another owner', async () => {
    const { app } = svc({ submitsPerMinute: 2 })
    const h = (n: number) => 'sha256:' + String(n).padStart(2, '0').repeat(32)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(1) })).status).toBe(201)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(2) })).status).toBe(201)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(3) })).status).toBe(429)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-b').send({ hash: h(4) })).status).toBe(201)
  })

  it('rejects a hand-edited store line (C2)', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(created.status).toBe(201)
    const path = join(dir, 'anchors.jsonl')
    const row = JSON.parse(readFileSync(path, 'utf-8').trim()) as { owner: string }
    row.owner = 'tampered'
    writeFileSync(path, JSON.stringify(row) + '\n')
    // RED 2026-08-15: the store is unsigned JSONL. Editing a line still
    // serves 200. A log that cannot notice a rewrite is not a log.
    const fetched = await request(app).get(`/anchor/${created.body.id}`)
    expect(fetched.status).toBe(503)
    expect(fetched.body.error).toMatch(/corrupt/)
    expect(() => validateAnchorLog([JSON.parse(readFileSync(path, 'utf-8').trim())])).toThrow(/corrupt/)
  })

  it('upgrades by appending a new row and keeps the original line', async () => {
    const { app, runStamp, runUpgrade, readStore } = svc()
    const a = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const b = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH2 })

    expect(await runStamp()).toEqual({ attempted: 1, stamped: 1 })
    const first = await runUpgrade()
    expect(first).toEqual({ checked: 1, upgraded: 1 })
    const rows = readStore()
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => r.type === 'submit').every((r) => r.state === 'pending')).toBe(true)
    expect(rows.filter((r) => r.type === 'stamp').every((r) => r.state === 'pending')).toBe(true)
    expect(rows.filter((r) => r.type === 'upgrade').every((r) => r.state === 'bitcoin' && r.bitcoinBlock === 961333)).toBe(true)
    expect(rows[3].upgradesSeq).toBe(rows[2].seq)
    validateAnchorLog(rows)

    const onDisk = readFileSync(join(dir, 'anchors.jsonl'), 'utf-8').trim().split('\n')
    expect(JSON.parse(onDisk[0]).state).toBe('pending')
    expect(JSON.parse(onDisk[0]).type).toBe('submit')

    expect(await runUpgrade()).toEqual({ checked: 0, upgraded: 0 })

    const viewed = await request(app).get(`/anchor/${a.body.id}`)
    expect(viewed.body.digest).toBe(HASH)
    expect(viewed.body.id).toBe(a.body.id)
    expect(viewed.body.inclusion.head.state).toBe('bitcoin')

    const head = await request(app).get('/anchor/log/head')
    expect(head.status).toBe(200)
    expect(head.body.seq).toBe(4)
    expect(head.body.hash).toBe(rows[3].hash)
    expect(head.body.state).toBe('bitcoin')
    expect(b.body.seq).toBe(2)
  })

  it('keeps a record pending when the upgrade throws, rather than losing it', async () => {
    const { app, runStamp, runUpgrade, readStore } = svc({
      upgrade: async () => {
        throw new Error('calendar 500')
      },
    })
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(await runStamp()).toEqual({ attempted: 1, stamped: 1 })
    expect(await runUpgrade()).toEqual({ checked: 1, upgraded: 0 })
    expect(readStore().every((r) => r.state === 'pending')).toBe(true)
  })

  it('serves the raw proof so a third party can verify without this service', async () => {
    const { app, runStamp } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect((await request(app).get(`/anchor/${created.body.id}/ots`)).status).toBe(404)
    await runStamp()
    const raw = await request(app).get(`/anchor/${created.body.id}/ots`)
    expect(raw.status).toBe(200)
    expect(raw.body.toString()).toBe('fake-ots-proof')
  })

  it('answers html to a browser and json to everything else, and says so', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const html = await request(app).get(`/anchor/${created.body.id}`).set('accept', 'text/html')
    expect(html.headers['content-type']).toMatch(/html/)
    expect(html.headers['vary']).toMatch(/Accept/)
    expect(html.text).toContain(HASH)

    const json = await request(app).get(`/anchor/${created.body.id}`).set('accept', 'application/json')
    expect(json.headers['content-type']).toMatch(/json/)
  })

  it('GET /anchor describes the service instead of Express saying Cannot GET', async () => {
    const { app } = svc()

    const html = await request(app).get('/anchor').set('accept', 'text/html')
    expect(html.status).toBe(200)
    expect(html.text).not.toMatch(/Cannot GET/)
    expect(html.text).not.toMatch(/<title>Error<\/title>/)
    // the three things a visitor needs: who signs, where the key is, how to check
    expect(html.text).toContain('test-anchor-key')
    expect(html.text).toContain('/anchor/key.pem')
    expect(html.text).toContain('conarium-countersign-verify')
    // and the sentence that keeps the claim honest
    expect(html.text).toMatch(/does not say your records were correct/i)

    const json = await request(app).get('/anchor').set('accept', 'application/json')
    expect(json.status).toBe(200)
    expect(json.body.keyId).toBe('test-anchor-key')
    expect(json.body.submit.method).toBe('POST')
    expect(Array.isArray(json.body.limits)).toBe(true)
    // the index must never carry anything that is not already public
    expect(JSON.stringify(json.body)).not.toMatch(/PRIVATE KEY|tok-a|Bearer tok/)
  })

  it('returns an inclusion proof that independently verifies (C3)', async () => {
    const { app, readStore } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH2 })
    const fetched = await request(app).get(`/anchor/${created.body.id}`)
    expect(fetched.status).toBe(200)
    // RED 2026-08-15: GET returns the record but not a path to the log head.
    expect(fetched.body.inclusion).toEqual(
      expect.objectContaining({
        seq: 1,
        hash: expect.any(String),
        head: expect.objectContaining({ seq: 2, hash: expect.any(String) }),
        path: expect.any(Array),
      }),
    )
    const rec = readStore()[0]
    expect(verifyInclusionProof(rec, fetched.body.inclusion)).toBe(true)
  })

  it('cannot produce an inclusion proof for a deleted or moved record', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH2 })
    const path = join(dir, 'anchors.jsonl')
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    writeFileSync(path, lines[1] + '\n')
    expect((await request(app).get(`/anchor/${created.body.id}`)).status).not.toBe(200)
  })

  it('404s an unknown id instead of leaking whether it ever existed', async () => {
    const { app } = svc()
    expect((await request(app).get('/anchor/does-not-exist')).status).toBe(404)
    expect((await request(app).get('/anchor/does-not-exist/ots')).status).toBe(404)
  })
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
