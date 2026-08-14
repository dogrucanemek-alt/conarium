/**
 * G11 — pin'siz verify UX + --strict + view komutu pin'li.
 * KIRMIZI: bugünkü CLI pin'siz koşuda not yok / --strict yok / view pin'siz.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCommandFor } from './console-receipts.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERIFY = join(ROOT, 'bin', 'conarium-verify.mjs')
const VECTOR = join(ROOT, 'test-vectors', '002-chain-of-three', 'receipts.jsonl')
const PUB = join(ROOT, 'test-vectors', 'keys', 'vector-key.pub.pem')
const LAST =
  'sha256:a06a30c3fb4bdbd46bb9400da0815fb3a7007b703cc9cb41208be08413e254c7'

function verify(file: string, extra: string[] = []) {
  const r = spawnSync(process.execPath, [VERIFY, file, '--pubkey', PUB, ...extra], {
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

describe('G11 verify tail-pin UX', () => {
  it('unpinned run exits 0 and says the tail was not seen', () => {
    const r = verify(VECTOR)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/tail truncation is not visible|son-N|not see receipts deleted/i)
    expect(r.stderr).toMatch(/--expect-count/)
    expect(r.stderr).toMatch(/--expect-last-hash/)
  })

  it('--json carries tailPinned false without a pin, true with one', () => {
    const bare = verify(VECTOR, ['--json'])
    expect(bare.status).toBe(0)
    const bareJson = JSON.parse(bare.stdout.trim().split('\n').pop() || '{}')
    expect(bareJson.tailPinned).toBe(false)

    const pinned = verify(VECTOR, ['--json', '--expect-count', '3'])
    expect(pinned.status).toBe(0)
    const pinnedJson = JSON.parse(pinned.stdout.trim().split('\n').pop() || '{}')
    expect(pinnedJson.tailPinned).toBe(true)
  })

  it('--strict without a tail pin exits non-zero; default stay 0', () => {
    const loose = verify(VECTOR)
    expect(loose.status).toBe(0)
    const strict = verify(VECTOR, ['--strict'])
    expect(strict.status).not.toBe(0)
    expect(strict.status).not.toBe(20)
    expect(strict.stderr).not.toMatch(/unknown flag/)
    expect(strict.stderr).toMatch(/strict|tail pin|--expect-count/i)
  })

  it('--strict pins seq from 1 when --expect-seq-from is omitted', () => {
    const lines = readFileSync(VECTOR, 'utf8').trim().split('\n')
    const first = JSON.parse(lines[0]) as { chain: { seq: number } }
    expect(first.chain.seq).toBe(1)
    const r = verify(VECTOR, ['--strict', '--expect-count', '3'])
    expect(r.status).toBe(0)
  })

  it('view command pins count+hash so a tail delete is caught', () => {
    const lines = readFileSync(VECTOR, 'utf8').trim().split('\n')
    const pin = { count: 3, lastHash: LAST }
    const cmd = (
      verifyCommandFor as (s: string, p?: { count: number; lastHash: string }) => string
    )('receipts.jsonl', pin)
    expect(cmd).toContain('--expect-count 3')
    expect(cmd).toContain(`--expect-last-hash ${LAST}`)

    const dir = mkdtempSync(join(tmpdir(), 'cnr-g11-'))
    const cut = join(dir, 'tail-cut.jsonl')
    writeFileSync(cut, lines.slice(0, 2).join('\n') + '\n')

    const unpinned = verify(cut)
    expect(unpinned.status).toBe(0)

    const pinned = verify(cut, ['--expect-count', String(pin!.count), '--expect-last-hash', pin!.lastHash])
    expect(pinned.status).toBe(11)
  })
})
