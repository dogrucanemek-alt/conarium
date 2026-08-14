/**
 * G20 L5 — audit sink hash is JSON.stringify, receipts are JCS.
 * Migrating the sink hasher would invalidate every existing audit file.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeEntryHash } from './audit-hash.js'
import { canonicalize } from './receipt.js'

describe('G20 L5 audit hasher is not JCS', () => {
  it('JSON.stringify and JCS disagree on key order — do not migrate', () => {
    const entry = { b: 1, a: 2, ts: 'x' }
    const raw = JSON.stringify(entry)
    const jcs = canonicalize(entry)
    expect(raw).not.toBe(jcs)
    expect(raw).toBe('{"b":1,"a":2,"ts":"x"}')
    expect(jcs).toBe('{"a":2,"b":1,"ts":"x"}')

    const stringifyHash = createHash('sha256').update(raw).digest('hex')
    const jcsHash = createHash('sha256').update(jcs).digest('hex')
    expect(computeEntryHash(entry)).toBe(stringifyHash)
    expect(computeEntryHash(entry)).not.toBe(jcsHash)
  })
})
