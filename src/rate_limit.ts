/**
 * Sliding-window rate limiter for the remote HTTP entrypoint.
 *
 * Public demo deployments hand the URL to strangers, so an unmetered endpoint is an
 * open invitation to loop it. Private deployments leave the limit at 0 (off).
 *
 * Trust note: behind a reverse proxy the peer address is always the proxy, so the
 * client comes from X-Forwarded-For. A client can forge that header, but the proxy
 * APPENDS the real peer, so only the LAST entry is trustworthy — never the first.
 */
export interface RateLimitOptions {
  /** Requests allowed per window, per client. 0 disables the limiter entirely. */
  perWindow: number
  /** Window length in ms (default 60s). */
  windowMs?: number
  /** Injectable clock — tests must not depend on wall time. */
  now?: () => number
}

export class RateLimiter {
  private readonly perWindow: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly hits = new Map<string, number[]>()

  constructor(opts: RateLimitOptions) {
    this.perWindow = Math.max(0, opts.perWindow)
    this.windowMs = opts.windowMs ?? 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  get enabled(): boolean {
    return this.perWindow > 0
  }

  /** True if the request may proceed; false when the client is over its budget. */
  take(client: string): boolean {
    if (!this.enabled) return true
    const now = this.now()
    const cutoff = now - this.windowMs
    const recent = (this.hits.get(client) ?? []).filter(t => t > cutoff)
    if (recent.length >= this.perWindow) {
      this.hits.set(client, recent)
      return false
    }
    recent.push(now)
    this.hits.set(client, recent)
    return true
  }

  /** Seconds until this client's oldest hit expires (for Retry-After). */
  retryAfter(client: string): number {
    const recent = this.hits.get(client)
    if (!recent?.length) return 1
    const oldest = recent[0]
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000))
  }

  /** Drop clients whose window has fully expired — the map must not grow forever. */
  sweep(): void {
    const cutoff = this.now() - this.windowMs
    for (const [client, times] of this.hits) {
      if (!times.some(t => t > cutoff)) this.hits.delete(client)
    }
  }

  /** Number of tracked clients — exposed for tests/monitoring. */
  get size(): number {
    return this.hits.size
  }
}

/**
 * Resolve the client identity from a proxied request.
 * Takes the LAST X-Forwarded-For entry (the one the trusted proxy appended);
 * spoofed values sit earlier in the list and are ignored.
 */
export function clientKey(headers: Record<string, unknown>, remoteAddress?: string): string {
  const raw = headers['x-forwarded-for']
  const xff = Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
  const parts = xff
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (parts.length) return parts[parts.length - 1]
  return remoteAddress || 'unknown'
}
