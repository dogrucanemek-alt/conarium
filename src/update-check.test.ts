import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import { updateNotice, cmpSemver } from './update-check.js'

/**
 * The gateway speaks MCP over stdout, so this code may only ever touch stderr —
 * and it must never delay or break a start. These tests pin both: silence on
 * failure, and a notice only when there is genuinely something newer.
 */
function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => s.close(() => r())),
      })
    })
  })
}

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CONARIUM_NO_UPDATE_CHECK
  delete process.env.CONARIUM_NPM_REGISTRY
})
afterEach(() => {
  process.env = { ...saved }
})

describe('cmpSemver', () => {
  it('orders by numeric parts', () => {
    expect(cmpSemver('0.2.0', '0.1.9')).toBe(1)
    expect(cmpSemver('0.1.2', '0.1.2')).toBe(0)
    expect(cmpSemver('0.1.2', '0.2.0')).toBe(-1)
    expect(cmpSemver('1.0.0', '0.99.99')).toBe(1)
  })
})

describe('updateNotice', () => {
  it('announces a newer published version', async () => {
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: '9.9.9' }))
    })
    process.env.CONARIUM_NPM_REGISTRY = s.url
    const msg = await updateNotice({ installed: '0.2.0' })
    await s.close()
    expect(msg).toMatch(/0\.2\.0 → 9\.9\.9/)
    expect(msg).toMatch(/npm i @conarium-ai\/core@9\.9\.9/)
  })

  it('says nothing when the installed version is current', async () => {
    const s = await serve((_req, res) => res.end(JSON.stringify({ version: '0.2.0' })))
    process.env.CONARIUM_NPM_REGISTRY = s.url
    const msg = await updateNotice({ installed: '0.2.0' })
    await s.close()
    expect(msg).toBeNull()
  })

  it('says nothing when the registry is older than what is installed', async () => {
    const s = await serve((_req, res) => res.end(JSON.stringify({ version: '0.1.0' })))
    process.env.CONARIUM_NPM_REGISTRY = s.url
    const msg = await updateNotice({ installed: '0.2.0' })
    await s.close()
    expect(msg).toBeNull()
  })

  it('is silent when the registry errors — a start must not depend on npm', async () => {
    const s = await serve((_req, res) => {
      res.statusCode = 500
      res.end('nope')
    })
    process.env.CONARIUM_NPM_REGISTRY = s.url
    const msg = await updateNotice({ installed: '0.2.0' })
    await s.close()
    expect(msg).toBeNull()
  })

  it('is silent when the registry is unreachable', async () => {
    process.env.CONARIUM_NPM_REGISTRY = 'http://127.0.0.1:1/'
    expect(await updateNotice({ installed: '0.2.0' })).toBeNull()
  })

  it('gives up within its budget instead of holding the start', async () => {
    const s = await serve(() => {
      /* never answers */
    })
    process.env.CONARIUM_NPM_REGISTRY = s.url
    const t0 = Date.now()
    const msg = await updateNotice({ installed: '0.2.0', timeoutMs: 300 })
    const elapsed = Date.now() - t0
    await s.close()
    expect(msg).toBeNull()
    expect(elapsed).toBeLessThan(2000)
  })

  it('makes no request at all when opted out', async () => {
    let hits = 0
    const s = await serve((_req, res) => {
      hits++
      res.end(JSON.stringify({ version: '9.9.9' }))
    })
    process.env.CONARIUM_NPM_REGISTRY = s.url
    process.env.CONARIUM_NO_UPDATE_CHECK = '1'
    const msg = await updateNotice({ installed: '0.2.0' })
    await s.close()
    expect(msg).toBeNull()
    expect(hits).toBe(0)
  })
})
