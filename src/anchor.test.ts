import { describe, expect, it, vi } from 'vitest'
import { AnchorScheduler, MemoryAnchorSink, type AnchorSink } from './anchor.js'

describe('T7 anchor scheduler', () => {
  it('does not block on sink failure; returns null', async () => {
    const failing: AnchorSink = {
      async submit() {
        throw new Error('network down')
      },
    }
    const sched = new AnchorScheduler(failing, { everyN: 1, failWarnAfter: 1 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await sched.maybeAnchor({
      hash: 'sha256:' + 'ab'.repeat(32),
      seq: 1,
      keyId: 'cnr-test',
    })
    expect(result).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('MemoryAnchorSink records only hash+seq+keyId', async () => {
    const mem = new MemoryAnchorSink()
    const sched = new AnchorScheduler(mem, { everyN: 1 })
    const payload = { hash: 'sha256:' + 'cd'.repeat(32), seq: 42, keyId: 'cnr-2026-07' }
    const result = await sched.maybeAnchor(payload)
    expect(result).not.toBeNull()
    expect(mem.entries).toHaveLength(1)
    expect(mem.entries[0].hash).toBe(payload.hash)
    expect(mem.entries[0].seq).toBe(42)
    expect(JSON.stringify(mem.entries[0])).not.toContain('customers')
    expect(JSON.stringify(mem.entries[0])).not.toContain('email')
  })

  it('everyN gates submissions', async () => {
    const mem = new MemoryAnchorSink()
    const sched = new AnchorScheduler(mem, { everyN: 3, everyMs: 999_999_999 })
    const payload = { hash: 'sha256:' + 'ef'.repeat(32), seq: 1, keyId: 'k' }
    expect(await sched.maybeAnchor(payload)).toBeNull()
    expect(await sched.maybeAnchor({ ...payload, seq: 2 })).toBeNull()
    expect(await sched.maybeAnchor({ ...payload, seq: 3 })).not.toBeNull()
    expect(mem.entries).toHaveLength(1)
  })
})
