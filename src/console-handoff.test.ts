import { describe, expect, it } from 'vitest'
import { createHandoffStore, HANDOFF_TTL_MS } from './console-handoff.js'

describe('handoff nonce', () => {
  it('is one-time', () => {
    const s = createHandoffStore()
    const n = s.issue()
    expect(s.consume(n)).toBe(true)
    expect(s.consume(n)).toBe(false)
    expect(s.size()).toBe(0)
  })

  it('rejects an unknown nonce', () => {
    const s = createHandoffStore()
    expect(s.consume('nope')).toBe(false)
  })

  it('expires after the TTL', () => {
    let t = 1_000
    const s = createHandoffStore({ ttlMs: HANDOFF_TTL_MS, now: () => t })
    const n = s.issue()
    t += HANDOFF_TTL_MS + 1
    expect(s.consume(n)).toBe(false)
  })

  it('is still valid just before expiry', () => {
    let t = 1_000
    const s = createHandoffStore({ ttlMs: 30_000, now: () => t })
    const n = s.issue()
    t += 29_999
    expect(s.consume(n)).toBe(true)
  })
})
