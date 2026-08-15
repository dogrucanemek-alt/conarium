/**
 * Countersign a stored anchor record.
 *
 * Canonical form is receipt.ts JCS (sorted keys, no whitespace). The signed
 * body is the record with `sig` removed — the same exclusion audit-hash uses
 * for the signature itself. Customer `hash`, and later seq/prevHash, stay in.
 * Do not invent a second canonicalize.
 */
import { createHash } from 'crypto'
import { canonicalize } from './receipt.js'
import { signHash, verifyHash, type SigningKey, type VerifyKey } from './keys.js'

export interface CountersignSig {
  alg: 'Ed25519'
  keyId: string
  value: string
}

export function countersignBody(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record }
  delete copy.sig
  return copy
}

export function countersignDigest(record: Record<string, unknown>): string {
  const digest = createHash('sha256').update(canonicalize(countersignBody(record))).digest('hex')
  return `sha256:${digest}`
}

export function signAnchorRecord<T extends object>(
  record: T,
  key: SigningKey,
): T & { sig: CountersignSig } {
  const digest = countersignDigest(record as Record<string, unknown>)
  return {
    ...record,
    sig: {
      alg: 'Ed25519',
      keyId: key.keyId,
      value: signHash(key, digest),
    },
  }
}

export function verifyAnchorRecord(record: Record<string, unknown>, key: VerifyKey): boolean {
  const raw = record.sig
  if (!raw || typeof raw !== 'object') return false
  const sig = raw as CountersignSig
  if (sig.alg !== 'Ed25519' || typeof sig.value !== 'string') return false
  if (sig.keyId !== key.keyId) return false
  return verifyHash(key, countersignDigest(record), sig.value)
}

/** Same content check as nexus/deploy/hetzner-proof-route.mjs — never serve a private PEM. */
export function isServablePublicPem(text: string): boolean {
  if (!text.includes('BEGIN PUBLIC KEY')) return false
  return !/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)
}
