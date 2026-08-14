import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { waitForListen } from './console-ready.js'

function reservePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

describe('waitForListen', () => {
  it('returns once the port accepts a connection', async () => {
    const port = await reservePort()
    const server = createServer()
    setTimeout(() => server.listen(port, '127.0.0.1'), 50)
    await waitForListen('127.0.0.1', port, { timeoutMs: 3_000, intervalMs: 20 })
    await new Promise((r) => server.close(r))
    expect(port).toBeGreaterThan(0)
  })

  it('fails at the timeout when nothing listens', async () => {
    await expect(waitForListen('127.0.0.1', 1, { timeoutMs: 200, intervalMs: 40 })).rejects.toThrow(
      /did not listen/,
    )
  })
})
