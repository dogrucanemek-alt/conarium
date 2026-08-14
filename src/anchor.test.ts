import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AnchorScheduler,
  MemoryAnchorSink,
  hashPrefixToBuffer,
  createAnchorSinkFromEnv,
  appendAnchorSidecar,
  resultToSidecarRecord,
  resultToReceiptAnchor,
  type AnchorSink,
  type AnchorPayload,
} from './anchor.js'
import { buildReceipt, nextChainState, hashArgs, type ReceiptInput } from './receipt.js'
import { generateKeyPair } from './keys.js'
import { createPrivateKey } from 'crypto'

function sampleInput(): ReceiptInput {
  return {
    period: { start: '2026-07-29T00:00:00.000Z', end: '2026-07-29T00:00:01.000Z' },
    actor: { id: 'conarium_test' },
    model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
    client: { name: 'cursor', version: '2.x' },
    request: { tool: 'query', target: 'demo-db', argsHash: hashArgs({ sql: 'select 1' }) },
    dataRefs: [{ source: 'demo', object: 'v_monthly', fieldsRequested: ['month', 'revenue'] }],
    policy: {
      id: 'conarium.config.c2',
      version: '3',
      decision: 'allow',
      rulesApplied: ['allowlist.table'],
    },
    flags: [],
    masking: { maskedCount: 0, byClass: {}, rowsReturned: 1, rowCapApplied: false },
    outcome: { status: 'complete', denied: false },
  }
}

describe('A6 OpenTimestamps anchoring', () => {
  it('A6.1 sha256: prefix → OTS buffer is 32 correct bytes', () => {
    const hex = '05c4f616a8e5310d19d938cfd769864d7f4ccdc2ca8b479b10af83564b097af9'
    const buf = hashPrefixToBuffer(`sha256:${hex}`)
    expect(buf).toHaveLength(32)
    expect(buf.equals(Buffer.from(hex, 'hex'))).toBe(true)
    expect(hashPrefixToBuffer(hex).equals(buf)).toBe(true)
  })

  it('A6.2 failing sink does not block receipt production; anchor stays null', async () => {
    const failing: AnchorSink = {
      async submit() {
        throw new Error('network down')
      },
    }
    const sched = new AnchorScheduler(failing, { everyN: 1, failWarnAfter: 99 })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pair = generateKeyPair('cnr-a62')
    const key = { keyId: 'cnr-a62', privateKey: createPrivateKey(pair.privatePem) }
    const receipt = buildReceipt(sampleInput(), nextChainState(null), key)
    const result = await sched.maybeAnchor({
      hash: receipt.chain.hash,
      seq: receipt.chain.seq,
      keyId: 'cnr-a62',
    })
    expect(result).toBeNull()
    expect(receipt.anchor).toBeNull()
    expect(receipt.chain.hash.startsWith('sha256:')).toBe(true)
    spy.mockRestore()
  })

  it('A6.3 three consecutive failures call console.error', async () => {
    const failing: AnchorSink = {
      async submit() {
        throw new Error('down')
      },
    }
    const sched = new AnchorScheduler(failing, { everyN: 1, failWarnAfter: 3 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload: AnchorPayload = {
      hash: 'sha256:' + 'ab'.repeat(32),
      seq: 1,
      keyId: 'k',
    }
    await sched.maybeAnchor(payload)
    await sched.maybeAnchor({ ...payload, seq: 2 })
    await sched.maybeAnchor({ ...payload, seq: 3 })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('A6.4 EVERY_N=2 → one submit per two receipts', async () => {
    const mem = new MemoryAnchorSink()
    const sched = new AnchorScheduler(mem, { everyN: 2, everyMs: 999_999_999 })
    for (let i = 1; i <= 4; i++) {
      await sched.maybeAnchor({
        hash: 'sha256:' + i.toString(16).padStart(64, '0'),
        seq: i,
        keyId: 'k',
      })
    }
    expect(mem.calls).toHaveLength(2)
  })

  it('A6.8 CONARIUM_ANCHOR_SINK=none → no sink / no network', () => {
    const prev = process.env.CONARIUM_ANCHOR_SINK
    process.env.CONARIUM_ANCHOR_SINK = 'none'
    try {
      expect(createAnchorSinkFromEnv()).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.CONARIUM_ANCHOR_SINK
      else process.env.CONARIUM_ANCHOR_SINK = prev
    }
  })

  it('CONARIUM_ANCHOR_SINK=opentimestamps uses the built-in client (no extra package)', () => {
    const prev = process.env.CONARIUM_ANCHOR_SINK
    process.env.CONARIUM_ANCHOR_SINK = 'opentimestamps'
    try {
      expect(createAnchorSinkFromEnv()).not.toBeNull()
    } finally {
      if (prev === undefined) delete process.env.CONARIUM_ANCHOR_SINK
      else process.env.CONARIUM_ANCHOR_SINK = prev
    }
  })

  it('sidecar + receipt ref helpers only carry hash/seq metadata', async () => {
    const mem = new MemoryAnchorSink()
    const payload = { hash: 'sha256:' + 'cd'.repeat(32), seq: 42, keyId: 'cnr-2026-07' }
    const result = await mem.submit(payload)
    const row = resultToSidecarRecord(payload, result)
    const ref = resultToReceiptAnchor(payload, result)
    expect(JSON.stringify(row)).not.toContain('customers')
    expect(JSON.stringify(row)).not.toContain('email')
    expect(ref.ref).toBe(payload.hash)
    expect(ref.log).toBe('memory')
    const dir = mkdtempSync(join(tmpdir(), 'cnr-side-'))
    const side = join(dir, 'audit.jsonl.anchors.jsonl')
    appendAnchorSidecar(side, row)
  })
})
