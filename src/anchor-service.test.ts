import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPrivateKey, createPublicKey } from 'crypto'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import request from 'supertest'
import { createAnchorService } from './anchor-service.js'
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
    expect(fetched.body.hash).toBe(HASH)
  })

  it('never returns the owner or the token in a public view', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const body = JSON.stringify((await request(app).get(`/anchor/${created.body.id}`)).body)
    expect(body).not.toContain('acme')
    expect(body).not.toContain('tok-a')
  })

  it('fails loudly when the calendar is down instead of pretending to anchor', async () => {
    const { app } = svc({
      stamp: async () => {
        throw new Error('calendars unreachable')
      },
    })
    const res = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(res.status).toBe(502)
    // Nothing may be written: a stored record would claim an anchor that does not exist.
    expect(() => readFileSync(join(dir, 'anchors.jsonl'), 'utf-8')).toThrow()
  })

  it('deduplicates the same hash for the same owner, but not across owners', async () => {
    let calls = 0
    const { app } = svc({
      stamp: async () => {
        calls += 1
        return Buffer.from('p').toString('base64')
      },
    })
    const a1 = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    const a2 = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(a2.body.id).toBe(a1.body.id)
    expect(a2.body.deduplicated).toBe(true)
    expect(calls).toBe(1)

    const b1 = await request(app).post('/anchor').set('authorization', 'Bearer tok-b').send({ hash: HASH })
    expect(b1.body.id).not.toBe(a1.body.id)
    expect(calls).toBe(2)
  })

  it('enforces the per-owner rate limit without blocking another owner', async () => {
    const { app } = svc({ submitsPerMinute: 2 })
    const h = (n: number) => 'sha256:' + String(n).padStart(2, '0').repeat(32)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(1) })).status).toBe(201)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(2) })).status).toBe(201)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: h(3) })).status).toBe(429)
    expect((await request(app).post('/anchor').set('authorization', 'Bearer tok-b').send({ hash: h(4) })).status).toBe(201)
  })

  it('upgrades pending anchors to a block and is idempotent', async () => {
    const { app, runUpgrade, readStore } = svc()
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH2 })

    const first = await runUpgrade()
    expect(first).toEqual({ checked: 2, upgraded: 2 })
    const rows = readStore()
    expect(rows.every((r) => r.state === 'bitcoin' && r.bitcoinBlock === 961333)).toBe(true)

    // Nothing left pending: a second pass must be a no-op, not a re-submission.
    expect(await runUpgrade()).toEqual({ checked: 0, upgraded: 0 })
  })

  it('keeps a record pending when the upgrade throws, rather than losing it', async () => {
    const { app, runUpgrade, readStore } = svc({
      upgrade: async () => {
        throw new Error('calendar 500')
      },
    })
    await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
    expect(await runUpgrade()).toEqual({ checked: 1, upgraded: 0 })
    expect(readStore()[0].state).toBe('pending')
  })

  it('serves the raw proof so a third party can verify without this service', async () => {
    const { app } = svc()
    const created = await request(app).post('/anchor').set('authorization', 'Bearer tok-a').send({ hash: HASH })
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
