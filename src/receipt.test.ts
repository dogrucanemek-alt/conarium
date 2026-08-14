import { createPrivateKey } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  generateKeyPair,
  writeKeyPairFiles,
  loadSigningKey,
  loadVerifyKeys,
  signHash,
  verifyHash,
} from './keys.js'
import {
  buildReceipt,
  canonicalize,
  receiptHash,
  nextChainState,
  RECEIPT_GENESIS_HASH,
  hashArgs,
  type Receipt,
  type ReceiptInput,
} from './receipt.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY = join(HERE, '..', 'bin', 'conarium-verify.mjs')

function sampleInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    period: { start: '2026-07-29T00:00:00.000Z', end: '2026-07-29T00:00:01.000Z' },
    actor: { id: 'conarium_test' },
    model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
    client: { name: 'cursor', version: '2.x' },
    request: { tool: 'query', target: 'demo-db', argsHash: hashArgs({ sql: 'select 1' }) },
    dataRefs: [{ source: 'zion', object: 'v_monthly', fieldsRequested: ['month', 'revenue'] }],
    policy: {
      id: 'conarium.config.c2',
      version: '3',
      decision: 'partial',
      rulesApplied: ['allowlist.table', 'mask.pii'],
    },
    flags: [],
    masking: {
      maskedCount: 0,
      byClass: { email: 0, phone: 0, tckn: 0, secret: 0 },
      rowsReturned: 1,
      rowCapApplied: false,
    },
    outcome: { status: 'complete', denied: false },
    ...overrides,
  }
}

function runVerify(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

function chainOf(n: number, key: ReturnType<typeof loadSigningKey>, startSeq = 1): Receipt[] {
  if (!key) throw new Error('signing key required')
  const out: Receipt[] = []
  let state = startSeq === 1
    ? nextChainState(null)
    : { seq: startSeq, prevHash: RECEIPT_GENESIS_HASH }
  for (let i = 0; i < n; i++) {
    const r = buildReceipt(
      sampleInput({ id: `01TEST${String(i).padStart(20, '0')}`, ts: `2026-07-29T00:00:0${i}.000Z` }),
      state,
      key,
    )
    out.push(r)
    state = nextChainState(r)
  }
  return out
}

describe('T1 keys', () => {
  const prevEnv = { ...process.env }

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k]
    }
    Object.assign(process.env, prevEnv)
  })

  it('generate → sign → verify round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-keys-'))
    const { privatePath, publicPath } = writeKeyPairFiles(join(dir, 'cnr-2026-07'), 'cnr-2026-07')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath
    delete process.env.CONARIUM_AUDIT_KEY_ID
    const signing = loadSigningKey()
    expect(signing).not.toBeNull()
    if (!signing) throw new Error('unreachable')
    const hash = 'sha256:' + 'ab'.repeat(32)
    const sig = signHash(signing, hash)
    const verifyKeys = loadVerifyKeys([publicPath])
    expect(verifyKeys).toHaveLength(1)
    expect(verifyHash(verifyKeys[0], hash, sig)).toBe(true)
    expect(verifyHash(verifyKeys[0], hash + 'x', sig)).toBe(false)
  })

  it('rejects broken PEM with a meaningful error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-keys-bad-'))
    const bad = join(dir, 'bad.pem')
    writeFileSync(bad, 'not-a-pem\n')
    writeFileSync(bad + '.keyid', 'x\n')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = bad
    expect(() => loadSigningKey()).toThrow(/invalid Ed25519 private PEM/)
  })
})

describe('T2 receipt canonicalize + hash', () => {
  it('key order does not change canonicalize output', () => {
    const a = canonicalize({ b: 1, a: 2 })
    const b = canonicalize({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('same input → same hash (deterministic)', () => {
    const pair = generateKeyPair('cnr-det')
    const key = {
      keyId: 'cnr-det',
      privateKey: createPrivateKey(pair.privatePem),
    }
    const input = sampleInput({ id: '01FIXEDID0000000000000000', ts: '2026-07-29T08:00:00.000Z' })
    const r1 = buildReceipt(input, nextChainState(null), key)
    const r2 = buildReceipt(input, nextChainState(null), key)
    expect(r1.chain.hash).toBe(r2.chain.hash)
    // Recompute from body
    expect(receiptHash(r1)).toBe(r1.chain.hash)
  })

  it('K3: sig covers the body; sig and anchor are hash-exterior', () => {
    const pair = generateKeyPair('cnr-cov')
    const key = { keyId: 'cnr-cov', privateKey: createPrivateKey(pair.privatePem) }
    const r = buildReceipt(
      sampleInput({ id: '01FIXEDCOVER00000000000000', ts: '2026-07-29T08:00:00.000Z' }),
      nextChainState(null),
      key,
    )
    expect(receiptHash({ ...r, ts: '1999-01-01T00:00:00.000Z' })).not.toBe(r.chain.hash)
    expect(receiptHash({ ...r, actor: { ...r.actor, id: 'other' } })).not.toBe(r.chain.hash)
    expect(receiptHash({ ...r, masking: { ...r.masking, maskedCount: 99 } })).not.toBe(r.chain.hash)
    expect(receiptHash({ ...r, anchor: { log: 'x', ref: 'y', state: 'pending' } })).toBe(r.chain.hash)
    expect(receiptHash({ ...r, sig: { alg: 'Ed25519', keyId: r.sig!.keyId, value: 'AAAA' } })).toBe(r.chain.hash)
  })

  it('actor.type is always service; consentRef always null', () => {
    const pair = generateKeyPair('cnr-act')
    const key = { keyId: 'cnr-act', privateKey: createPrivateKey(pair.privatePem) }
    const r = buildReceipt(sampleInput(), nextChainState(null), key)
    expect(r.actor.type).toBe('service')
    expect(r.consentRef).toBeNull()
    expect(r.anchor).toBeNull()
  })
})

describe('T3 fail-closed unsigned production', () => {
  const prev = process.env.CONARIUM_AUDIT_UNSIGNED

  afterEach(() => {
    if (prev === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
    else process.env.CONARIUM_AUDIT_UNSIGNED = prev
  })

  it('T5.9: no key + no env → buildReceipt throws', () => {
    delete process.env.CONARIUM_AUDIT_UNSIGNED
    expect(() => buildReceipt(sampleInput(), nextChainState(null), null)).toThrow(/refusing to produce an unsigned receipt/)
  })

  it('unsigned env allows null sig with warning path', () => {
    process.env.CONARIUM_AUDIT_UNSIGNED = '1'
    const r = buildReceipt(sampleInput(), nextChainState(null), null)
    expect(r.sig).toBeNull()
    expect(r.chain.hash.startsWith('sha256:')).toBe(true)
  })
})

describe('T5 verify scenarios', () => {
  let dir: string
  let privatePath: string
  let publicPath: string
  let key: NonNullable<ReturnType<typeof loadSigningKey>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cnr-verify-'))
    const written = writeKeyPairFiles(join(dir, 'cnr-2026-07'), 'cnr-2026-07')
    privatePath = written.privatePath
    publicPath = written.publicPath
    process.env.CONARIUM_AUDIT_SIGNING_KEY = privatePath
    key = loadSigningKey()!
  })

  function writeChain(receipts: Receipt[], name = 'chain.jsonl'): string {
    const path = join(dir, name)
    writeFileSync(path, receipts.map((r) => JSON.stringify(r)).join('\n') + '\n')
    return path
  }

  it('T5.1 tampered field → exit 10', () => {
    const receipts = chainOf(3, key)
    receipts[1] = { ...receipts[1], flags: ['tampered'] }
    const path = writeChain(receipts)
    const res = runVerify([path, '--pubkey', publicPath])
    expect(res.code).toBe(10)
    expect(res.stderr).toMatch(/hash mismatch/)
  })

  it('T5.2 delete middle → exit 11', () => {
    const receipts = chainOf(3, key)
    const path = writeChain([receipts[0], receipts[2]])
    const res = runVerify([path, '--pubkey', publicPath])
    expect(res.code).toBe(11)
    expect(res.stderr).toMatch(/prevHash break/)
  })

  it('T5.3 swap two → exit 11 or 12', () => {
    const receipts = chainOf(3, key)
    const path = writeChain([receipts[0], receipts[2], receipts[1]])
    const res = runVerify([path, '--pubkey', publicPath])
    expect([11, 12]).toContain(res.code)
  })

  it('T5.4 seq skip 1041→1043 → exit 12', () => {
    const a = buildReceipt(sampleInput({ id: '01A' }), { seq: 1041, prevHash: RECEIPT_GENESIS_HASH }, key)
    // Force seq 1043 with prevHash of a — gap
    const b = buildReceipt(sampleInput({ id: '01B' }), { seq: 1043, prevHash: a.chain.hash }, key)
    const path = writeChain([a, b])
    const res = runVerify([path, '--pubkey', publicPath])
    expect(res.code).toBe(12)
    expect(res.stderr).toMatch(/seq gap/)
  })

  it('T5.5 wrong key → exit 13', () => {
    const receipts = chainOf(2, key)
    const other = writeKeyPairFiles(join(dir, 'cnr-other'), 'cnr-other')
    const path = writeChain(receipts)
    const res = runVerify([path, '--pubkey', other.publicPath])
    expect(res.code).toBe(13)
  })

  it('T5.6 key rotation mixed chain with both pubkeys → 0', () => {
    const oldPair = writeKeyPairFiles(join(dir, 'cnr-old'), 'cnr-old')
    const newPair = writeKeyPairFiles(join(dir, 'cnr-new'), 'cnr-new')
    process.env.CONARIUM_AUDIT_SIGNING_KEY = oldPair.privatePath
    const oldKey = loadSigningKey()!
    const r0 = buildReceipt(sampleInput({ id: '01OLD' }), nextChainState(null), oldKey)
    process.env.CONARIUM_AUDIT_SIGNING_KEY = newPair.privatePath
    const newKey = loadSigningKey()!
    const r1 = buildReceipt(sampleInput({ id: '01NEW' }), nextChainState(r0), newKey)
    const path = writeChain([r0, r1])
    const res = runVerify([path, '--pubkey', oldPair.publicPath, '--pubkey', newPair.publicPath])
    expect(res.code).toBe(0)
  })

  it('T5.7 single receipt → 0 + warning', () => {
    const path = writeChain(chainOf(1, key))
    const res = runVerify([path, '--pubkey', publicPath])
    expect(res.code).toBe(0)
    expect(res.stderr).toMatch(/single-receipt/)
  })

  it('T5.8 anchor null + --anchor-check → 14', () => {
    const path = writeChain(chainOf(2, key))
    const res = runVerify([path, '--pubkey', publicPath, '--anchor-check'])
    expect(res.code).toBe(14)
    expect(res.stderr).toMatch(/anchor missing/)
  })

  it('T5.10 src/receipt.ts and bin/conarium-verify.mjs produce the same hash', async () => {
    const receipts = chainOf(1, key)
    const fromSrc = receiptHash(receipts[0])
    const mod = await import(pathToFileURL(join(HERE, '..', 'bin', 'conarium-verify.mjs')).href)
    const fromBin = mod.receiptHash(receipts[0])
    expect(fromBin).toBe(fromSrc)
    // Also: key-order scrambled object still matches
    const scrambled = {
      anchor: receipts[0].anchor,
      sig: receipts[0].sig,
      chain: receipts[0].chain,
      v: receipts[0].v,
      id: receipts[0].id,
      ts: receipts[0].ts,
      period: receipts[0].period,
      actor: receipts[0].actor,
      model: receipts[0].model,
      client: receipts[0].client,
      request: receipts[0].request,
      dataRefs: receipts[0].dataRefs,
      policy: receipts[0].policy,
      flags: receipts[0].flags,
      masking: receipts[0].masking,
      outcome: receipts[0].outcome,
      consentRef: receipts[0].consentRef,
    }
    expect(mod.receiptHash(scrambled)).toBe(fromSrc)
    expect(canonicalize({ z: 1, a: 2 })).toBe(mod.canonicalize({ a: 2, z: 1 }))
  })

  it('healthy chain → 0', () => {
    const path = writeChain(chainOf(3, key))
    const res = runVerify([path, '--pubkey', publicPath, '--json'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).ok).toBe(true)
  })

  it('no --pubkey → 13 fail-closed', () => {
    const path = writeChain(chainOf(1, key))
    const res = runVerify([path])
    expect(res.code).toBe(13)
  })
})
