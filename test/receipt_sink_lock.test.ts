/**
 * Two OS processes, one receipt sink. Same-process Audit pairs cannot
 * reproduce this: heldLocks is a per-process Map and dedupes.
 *
 * (a) receipt-only — no audit sink, so today's constructor takes no lock.
 * (b) different audit sinks, shared receipt sink — two locks, one file.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeKeyPairFiles } from '../src/keys.ts'

const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const childPath = fileURLToPath(new URL('./receipt_sink_lock_child.mjs', import.meta.url))
const verifyPath = fileURLToPath(new URL('../bin/conarium-verify.mjs', import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))

const ENV_SIGNING = 'CONARIUM_AUDIT_SIGNING_KEY'
const ENV_KEY_ID = 'CONARIUM_AUDIT_KEY_ID'
const PREV_SIGNING = process.env[ENV_SIGNING]
const PREV_KEY_ID = process.env[ENV_KEY_ID]

let keyDir: string
let privatePath: string
let publicPath: string
const KEY_ID = 'receipt-lock-test'

beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'conarium-lock-key-'))
  const files = writeKeyPairFiles(join(keyDir, 'audit-ed25519'), KEY_ID)
  privatePath = files.privatePath
  publicPath = files.publicPath
  process.env[ENV_SIGNING] = privatePath
  process.env[ENV_KEY_ID] = KEY_ID
})

afterAll(() => {
  if (PREV_SIGNING === undefined) delete process.env[ENV_SIGNING]
  else process.env[ENV_SIGNING] = PREV_SIGNING
  if (PREV_KEY_ID === undefined) delete process.env[ENV_KEY_ID]
  else process.env[ENV_KEY_ID] = PREV_KEY_ID
})

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (existsSync(path)) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`ready timeout: ${path}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

function parseReceipts(sink: string): { seq: number; prevHash: string; hash: string }[] {
  if (!existsSync(sink)) return []
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const r = JSON.parse(line) as { chain: { seq: number; prevHash: string; hash: string } }
      return { seq: r.chain.seq, prevHash: r.chain.prevHash, hash: r.chain.hash }
    })
}

async function raceTwoWriters(opts: {
  label: string
  receiptOnly: boolean
  writesPerChild: number
}): Promise<{ sink: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `conarium-lock-${opts.label}-`))
  const receiptSink = join(dir, 'receipts.jsonl')
  const goPath = join(dir, 'go')
  const readyA = join(dir, 'ready-a')
  const readyB = join(dir, 'ready-b')
  mkdirSync(dirname(receiptSink), { recursive: true })

  const baseEnv = {
    ...process.env,
    [ENV_SIGNING]: privatePath,
    [ENV_KEY_ID]: KEY_ID,
    CONARIUM_LOCK_RECEIPT: receiptSink,
    CONARIUM_LOCK_GO: goPath,
    CONARIUM_LOCK_N: String(opts.writesPerChild),
  }

  const spawnChild = (tag: string, ready: string, auditSink?: string) =>
    spawn(process.execPath, [tsxCli, childPath], {
      cwd: root,
      env: {
        ...baseEnv,
        CONARIUM_LOCK_READY: ready,
        CONARIUM_LOCK_TAG: tag,
        ...(auditSink ? { CONARIUM_LOCK_AUDIT: auditSink } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const a = spawnChild('a', readyA, opts.receiptOnly ? undefined : join(dir, 'audit-a.jsonl'))
  const b = spawnChild('b', readyB, opts.receiptOnly ? undefined : join(dir, 'audit-b.jsonl'))
  const stderr: string[] = []
  for (const c of [a, b]) {
    c.stderr.on('data', (buf: Buffer) => stderr.push(buf.toString()))
  }

  await Promise.all([waitForFile(readyA, 20_000), waitForFile(readyB, 20_000)])
  writeFileSync(goPath, 'go\n')

  const codes = await Promise.all(
    [a, b].map(
      (c) =>
        new Promise<number>((resolve) => {
          c.on('exit', (code) => resolve(code ?? 1))
        }),
    ),
  )
  expect(codes, stderr.join('\n')).toEqual([0, 0])
  return { sink: receiptSink, dir }
}

function assertChain(sink: string, expectedCount: number): void {
  const rows = parseReceipts(sink)
  const seqs = rows.map((r) => r.seq)
  expect(seqs, `duplicate seq: ${seqs.join(',')}`).toEqual(
    Array.from({ length: expectedCount }, (_, i) => i + 1),
  )
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].prevHash, `prevHash break at ${i}`).toBe(rows[i - 1].hash)
  }
  const verified = spawnSync(process.execPath, [verifyPath, sink, '--pubkey', publicPath], {
    cwd: root,
    encoding: 'utf8',
  })
  expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0)
}

describe('receipt sink lock — two OS processes', () => {
  it('(a) receipt-only: two processes, no seq fork', async () => {
    const n = 8
    const { sink } = await raceTwoWriters({ label: 'only', receiptOnly: true, writesPerChild: n })
    assertChain(sink, n * 2)
  }, 40_000)

  it('(b) different audit sinks, shared receipt sink: two processes, no seq fork', async () => {
    const n = 8
    const { sink } = await raceTwoWriters({ label: 'shared', receiptOnly: false, writesPerChild: n })
    assertChain(sink, n * 2)
  }, 40_000)
})
