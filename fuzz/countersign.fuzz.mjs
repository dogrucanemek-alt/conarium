/**
 * Fuzz countersign record parsing + digest + inclusion-proof shape checks.
 * Same rules as bin/conarium-countersign-verify.mjs; crashes only, not exit codes.
 */
import { canonicalize } from '../dist/receipt.js'

function digest(record) {
  const copy = { ...record }
  delete copy.sig
  return canonicalize(copy)
}

function inclusionLooksLikeProof(proof, record) {
  if (!proof || typeof proof !== 'object') return false
  if (!Array.isArray(proof.path)) return false
  for (const step of proof.path) {
    if (!step || typeof step !== 'object') return false
  }
  return proof.seq === record.seq
}

export function fuzz(data) {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  let rec
  try {
    rec = JSON.parse(raw)
  } catch {
    try {
      rec = JSON.parse(raw.split('\n')[0] || '')
    } catch {
      return
    }
  }
  if (!rec || typeof rec !== 'object') return
  try {
    digest(rec)
  } catch {
    return
  }
  if (rec.inclusion) inclusionLooksLikeProof(rec.inclusion, rec)
}
