import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveActor } from './tokens.js'

const PAYLASILAN = 'paylasilan-token-en-az-24-karakter-uzun'
const AYSE = 'ayse-kisisel-token-en-az-24-karakter'
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

let createHandler: typeof import('./http.js').createHandler
let ownerKey: typeof import('./http.js').ownerKey
let currentTokenStore: typeof import('./http.js').currentTokenStore
let tokensFile: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-life-'))
  tokensFile = join(dir, 'conarium.tokens.json')
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ sha256: sha256hex(AYSE), id: 'ayse' }] }))
  process.env.CONARIUM_TOKENS_FILE = tokensFile
  process.env.CONARIUM_MCP_TOKEN = PAYLASILAN
  const mod = await import('./http.js')
  createHandler = mod.createHandler
  ownerKey = mod.ownerKey
  currentTokenStore = mod.currentTokenStore
})

function sahteIstek(token: string, sessionId: string) {
  return {
    url: '/mcp',
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function sahteYanit() {
  const kayit = { status: 0, body: '', headersSent: false, headers: {} as Record<string, string> }
  return {
    kayit,
    writeHead(status: number, headers: Record<string, string>) {
      kayit.status = status
      kayit.headers = headers || {}
      kayit.headersSent = true
      return this
    },
    end(body?: string) { kayit.body = String(body ?? '') },
    get headersSent() { return kayit.headersSent },
  }
}

const deps = { config: { consumer: 'servis' }, connectors: [], governance: {}, audit: {} }
const limiter = { take: () => true, retryAfter: () => 0, enabled: false }

describe('G6 session idle TTL', () => {
  it('idle session is 404; an active one stays', async () => {
    let now = 1_000
    const transport = { handleRequest: async () => {} }
    const transports = new Map([['s1', { transport, owner: ownerKey(AYSE), lastActive: 1_000 }]])
    const handler = createHandler(deps as never, transports, limiter as never, {
      now: () => now,
      idleMs: 30_000,
    })

    now = 20_000
    const alive = sahteYanit()
    await handler(sahteIstek(AYSE, 's1') as never, alive as never)
    expect(alive.kayit.status).toBe(0)
    expect(transports.has('s1')).toBe(true)

    now = 60_000
    const dead = sahteYanit()
    await handler(sahteIstek(AYSE, 's1') as never, dead as never)
    expect(dead.kayit.status).toBe(404)
    expect(dead.kayit.body).toMatch(/session not found/)
    expect(transports.has('s1')).toBe(false)
  })
})

describe('G7 max sessions', () => {
  it('third initialize is rejected at cap 2; DELETE frees a slot', async () => {
    const transports = new Map<string, { transport: { handleRequest: () => Promise<void>; close?: () => Promise<void> }; owner: Buffer }>([
      ['a', { transport: { handleRequest: async () => {} }, owner: ownerKey(PAYLASILAN) }],
      ['b', { transport: { handleRequest: async () => {} }, owner: ownerKey(PAYLASILAN) }],
    ])
    const handler = createHandler(deps as never, transports, limiter as never, { maxSessions: 2 })
    const postEmpty = {
      url: '/mcp',
      method: 'POST',
      headers: { authorization: `Bearer ${PAYLASILAN}` },
      socket: { remoteAddress: '127.0.0.1' },
      on(ev: string, fn: () => void) {
        if (ev === 'end') queueMicrotask(fn)
      },
    }
    const blocked = sahteYanit()
    await handler(postEmpty as never, blocked as never)
    expect(blocked.kayit.status).toBe(429)
    expect(blocked.kayit.body).toMatch(/too many sessions/)

    transports.delete('a')
    const opened = sahteYanit()
    await handler(postEmpty as never, opened as never)
    expect(opened.kayit.status).not.toBe(429)
  })
})

describe('G8 token hot reload', () => {
  it('bad JSON keeps the previous store and logs', () => {
    writeFileSync(tokensFile, '{not-json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = currentTokenStore()
    expect(store?.get(sha256hex(AYSE))).toBe('ayse')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    writeFileSync(tokensFile, JSON.stringify({ tokens: [{ sha256: sha256hex(AYSE), id: 'ayse' }] }))
    currentTokenStore()
  })

  it('removing a token is visible on the next resolve', () => {
    writeFileSync(tokensFile, JSON.stringify({ tokens: [] }))
    const kisi = resolveActor(AYSE, currentTokenStore(), 'servis')
    expect(kisi.isUser).toBe(false)
  })
})
