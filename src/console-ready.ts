/**
 * Wait until a TCP port accepts a connection. No fixed sleep.
 */
import { createConnection } from 'node:net'

export async function waitForListen(
  host: string,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 100
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host, port })
      const done = (v: boolean) => {
        sock.removeAllListeners()
        sock.destroy()
        resolve(v)
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.setTimeout(intervalMs, () => done(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`console did not listen on ${host}:${port} within ${timeoutMs}ms`)
}
