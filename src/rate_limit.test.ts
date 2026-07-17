import { describe, expect, it } from 'vitest'
import { RateLimiter, clientKey } from './rate_limit.js'

describe('RateLimiter', () => {
  it('is a no-op when disabled (private deployments)', () => {
    const rl = new RateLimiter({ perWindow: 0 })
    expect(rl.enabled).toBe(false)
    for (let i = 0; i < 100; i++) expect(rl.take('a')).toBe(true)
  })

  it('allows up to the budget then blocks', () => {
    let t = 1_000
    const rl = new RateLimiter({ perWindow: 3, windowMs: 60_000, now: () => t })
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(false)
  })

  it('budgets each client separately', () => {
    let t = 1_000
    const rl = new RateLimiter({ perWindow: 1, windowMs: 60_000, now: () => t })
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(false)
    expect(rl.take('b')).toBe(true)
  })

  it('lets the window slide', () => {
    let t = 1_000
    const rl = new RateLimiter({ perWindow: 2, windowMs: 60_000, now: () => t })
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(false)
    t += 60_001
    expect(rl.take('a')).toBe(true)
  })

  it('reports a sane Retry-After', () => {
    let t = 1_000
    const rl = new RateLimiter({ perWindow: 1, windowMs: 60_000, now: () => t })
    rl.take('a')
    t += 10_000
    expect(rl.retryAfter('a')).toBe(50)
  })

  it('sweeps expired clients so the map cannot grow forever', () => {
    let t = 1_000
    const rl = new RateLimiter({ perWindow: 5, windowMs: 60_000, now: () => t })
    rl.take('a')
    rl.take('b')
    expect(rl.size).toBe(2)
    t += 60_001
    rl.sweep()
    expect(rl.size).toBe(0)
  })
})

describe('clientKey', () => {
  it('falls back to the socket peer without a proxy header', () => {
    expect(clientKey({}, '9.9.9.9')).toBe('9.9.9.9')
  })

  it('takes the LAST forwarded entry — the one the trusted proxy appended', () => {
    expect(clientKey({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }, '127.0.0.1')).toBe('198.51.100.7')
  })

  it('ignores a spoofed leading entry (client-supplied values sit first)', () => {
    // Attacker sends "X-Forwarded-For: victim"; proxy appends the real peer after it.
    const key = clientKey({ 'x-forwarded-for': 'victim-ip, 198.51.100.7' }, '127.0.0.1')
    expect(key).toBe('198.51.100.7')
    expect(key).not.toBe('victim-ip')
  })

  it('handles a header delivered as an array', () => {
    expect(clientKey({ 'x-forwarded-for': ['203.0.113.9', '198.51.100.7'] }, '127.0.0.1')).toBe('198.51.100.7')
  })

  it('degrades to "unknown" rather than throwing', () => {
    expect(clientKey({})).toBe('unknown')
  })
})
