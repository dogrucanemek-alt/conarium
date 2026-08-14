import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deserializeDetached, fileDigest, serializeDetached } from './format.js'
import { verifyProof } from './client.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'ots')
const DOGFOOD = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'dogfood',
  '2026-07-31-anchor.anchors.jsonl',
)

function hashPrefixToBuffer(hash: string): Buffer {
  const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash
  return Buffer.from(hex, 'hex')
}

describe('thin OTS client — old proofs still verify', () => {
  it('pending-matching.ots digest matches the committed receipt hash', async () => {
    const receipt = JSON.parse(readFileSync(join(FIX, 'chain-pending.jsonl'), 'utf-8').trim())
    const ots = readFileSync(join(FIX, 'pending-matching.ots'))
    const proof = deserializeDetached(ots)
    expect(fileDigest(proof).equals(hashPrefixToBuffer(receipt.chain.hash))).toBe(true)
    const v = await verifyProof(ots, hashPrefixToBuffer(receipt.chain.hash), { checkBitcoin: false })
    expect(v.ok).toBe(true)
    expect(v.pending).toBe(true)
  })

  it('other-ffff.ots is a digest mismatch against the receipt hash', async () => {
    const receipt = JSON.parse(readFileSync(join(FIX, 'chain-pending.jsonl'), 'utf-8').trim())
    const ots = readFileSync(join(FIX, 'other-ffff.ots'))
    const v = await verifyProof(ots, hashPrefixToBuffer(receipt.chain.hash))
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/does not match/i)
  })

  it('round-trip serialize of an old pending proof keeps the digest', () => {
    const ots = readFileSync(join(FIX, 'pending-matching.ots'))
    const proof = deserializeDetached(ots)
    const again = deserializeDetached(serializeDetached(proof))
    expect(fileDigest(again).equals(fileDigest(proof))).toBe(true)
  })

  it('dogfood 2026-07-31 proof (old library) parses as bitcoin height 960327', async () => {
    const row = JSON.parse(readFileSync(DOGFOOD, 'utf-8').trim().split('\n')[0])
    const ots = Buffer.from(row.ots, 'base64')
    const proof = deserializeDetached(ots)
    expect(fileDigest(proof).equals(hashPrefixToBuffer(row.hash))).toBe(true)
    const v = await verifyProof(ots, hashPrefixToBuffer(row.hash), { checkBitcoin: false })
    expect(v.ok).toBe(true)
    expect(v.bitcoin?.height).toBe(960327)
    expect(row.bitcoinBlock).toBe(960327)
  })
})
