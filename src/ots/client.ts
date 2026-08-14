/**
 * Thin OpenTimestamps client.
 * Stamp / upgrade / verify without javascript-opentimestamps (and without its tree).
 */
import { OtsError } from './codec.js'
import {
  calendarAllowed,
  DEFAULT_CALENDARS,
  fetchBitcoinBlock,
  fetchUpgraded,
  submitDigest,
} from './calendar.js'
import {
  collectAttestations,
  deserializeDetached,
  fileDigest,
  hasBitcoinAttestation,
  mergeTimestamp,
  nodesWithAttestations,
  serializeDetached,
  stampSkeleton,
  type DetachedProof,
} from './format.js'

export { OtsError } from './codec.js'
export { deserializeDetached, fileDigest, serializeDetached } from './format.js'

const MIN_CALENDAR_OK = 2

export async function stampHash(fileHash: Buffer, opts: { timeoutMs?: number; calendars?: string[] } = {}): Promise<Buffer> {
  if (fileHash.length !== 32) throw new OtsError('stampHash expects a 32-byte SHA-256 digest')
  const calendars = opts.calendars ?? DEFAULT_CALENDARS
  const timeoutMs = opts.timeoutMs ?? 15_000
  const { proof, tip } = stampSkeleton(fileHash)

  const results = await Promise.allSettled(calendars.map((url) => submitDigest(url, tip.msg, timeoutMs)))
  let ok = 0
  for (const r of results) {
    if (r.status === 'fulfilled') {
      mergeTimestamp(tip, r.value)
      ok++
    }
  }
  if (ok < Math.min(MIN_CALENDAR_OK, calendars.length)) {
    throw new OtsError(`stamping failed: ${ok} calendar(s) replied, need ${Math.min(MIN_CALENDAR_OK, calendars.length)}`)
  }
  return serializeDetached(proof)
}

export async function upgradeProof(
  otsBytes: Buffer,
  opts: { timeoutMs?: number } = {},
): Promise<{ changed: boolean; otsBytes: Buffer; bitcoinBlock: number | null }> {
  const proof = deserializeDetached(otsBytes)
  const timeoutMs = opts.timeoutMs ?? 15_000
  let changed = false

  for (const node of nodesWithAttestations(proof.timestamp)) {
    if (hasBitcoinAttestation(node)) continue
    for (const att of node.attestations) {
      if (att.kind !== 'pending') continue
      if (!calendarAllowed(att.uri)) continue
      try {
        const upgraded = await fetchUpgraded(att.uri, node.msg, timeoutMs)
        mergeTimestamp(node, upgraded)
        changed = true
      } catch {
        // calendar not ready or unreachable — leave pending
      }
    }
  }

  const btc = collectAttestations(proof.timestamp).find((x) => x.attestation.kind === 'bitcoin')
  return {
    changed,
    otsBytes: serializeDetached(proof),
    bitcoinBlock: btc && btc.attestation.kind === 'bitcoin' ? btc.attestation.height : null,
  }
}

export type VerifyResult = {
  ok: boolean
  pending: boolean
  unknown?: boolean
  bitcoin?: { height: number; time: number }
  detail?: string
}

function digestMismatch(proof: DetachedProof, hash: Buffer): string | null {
  if (!fileDigest(proof).equals(hash)) return 'ots proof digest does not match chain hash'
  return null
}

export async function verifyProof(
  otsBytes: Buffer,
  hash: Buffer,
  opts: { timeoutMs?: number; checkBitcoin?: boolean } = {},
): Promise<VerifyResult> {
  let proof: DetachedProof
  try {
    proof = deserializeDetached(otsBytes)
  } catch (err) {
    return { ok: false, pending: false, detail: err instanceof Error ? err.message : String(err) }
  }
  const mismatch = digestMismatch(proof, hash)
  if (mismatch) return { ok: false, pending: false, detail: mismatch }

  const atts = collectAttestations(proof.timestamp)
  const bitcoin = atts.filter((x) => x.attestation.kind === 'bitcoin')
  if (bitcoin.length === 0) return { ok: true, pending: true }

  if (opts.checkBitcoin === false) {
    const height = bitcoin[0].attestation.kind === 'bitcoin' ? bitcoin[0].attestation.height : null
    return { ok: true, pending: height == null, bitcoin: height != null ? { height, time: 0 } : undefined }
  }

  try {
    const first = bitcoin[0]
    if (first.attestation.kind !== 'bitcoin') return { ok: true, pending: true }
    const block = await fetchBitcoinBlock(first.attestation.height, opts.timeoutMs ?? 15_000)
    const digestLe = Buffer.from(first.msg).reverse()
    if (digestLe.toString('hex') !== block.merkleroot) {
      return { ok: false, pending: false, detail: 'Digest does not match merkleroot' }
    }
    return { ok: true, pending: false, bitcoin: { height: first.attestation.height, time: block.time } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: true, pending: false, unknown: true, detail: msg }
  }
}

export function parseOtsBase64(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}
