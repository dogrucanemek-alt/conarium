/**
 * One-time handoff nonce for the desktop launcher.
 * The long-lived console token never goes in a URL.
 */
import { randomBytes } from 'node:crypto'

export const HANDOFF_TTL_MS = 30_000

export interface HandoffEntry {
  exp: number
  used: boolean
}

export function createHandoffStore(opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? HANDOFF_TTL_MS
  const now = opts.now ?? Date.now
  const map = new Map<string, HandoffEntry>()

  function issue(): string {
    const n = randomBytes(24).toString('base64url')
    map.set(n, { exp: now() + ttl, used: false })
    return n
  }

  function consume(n: string): boolean {
    if (!n) return false
    const e = map.get(n)
    if (!e) return false
    if (e.used) return false
    if (now() > e.exp) {
      map.delete(n)
      return false
    }
    e.used = true
    map.delete(n)
    return true
  }

  return { issue, consume, size: () => map.size }
}

export interface ConsoleSession {
  csrf: string
}

export function createSessionStore() {
  const map = new Map<string, ConsoleSession>()

  function create(): { id: string; csrf: string } {
    const id = randomBytes(24).toString('base64url')
    const csrf = randomBytes(24).toString('base64url')
    map.set(id, { csrf })
    return { id, csrf }
  }

  function get(id: string): ConsoleSession | null {
    if (!id) return null
    return map.get(id) ?? null
  }

  return { create, get }
}
