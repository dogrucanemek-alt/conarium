/**
 * Offline license verifier.
 *
 * A Conarium license is a signed JSON object, verified the same way a receipt
 * is: RFC 8785 JCS canonicalize → SHA-256 → Ed25519. Nothing phones home.
 * "Your data never reaches us" would be a lie if the license check called us.
 *
 * This module is a verifier only. It does not generate keys, sell packs, take
 * payment, or gate features. A missing or invalid license is `community` —
 * fail-closed here would lock the MIT core, which is the opposite of MIT.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { canonicalize } from './receipt.js'

export type LicenseTier = 'community' | 'pro' | 'business' | 'enterprise'

export const LICENSE_TIERS: readonly LicenseTier[] = ['community', 'pro', 'business', 'enterprise']

export interface LicensePayload {
  customer: string
  tier: LicenseTier
  issuedAt: string
  expiresAt: string
  licenseId: string
}

export interface LicenseFile extends LicensePayload {
  sig: { alg: 'Ed25519'; keyId: string; value: string }
}

export interface LicenseVerifyResult {
  valid: boolean
  tier: LicenseTier
  customer: string | null
  expiresAt: string | null
  reason: string
}

function community(reason: string, extras: Partial<LicenseVerifyResult> = {}): LicenseVerifyResult {
  return {
    valid: false,
    tier: 'community',
    customer: extras.customer ?? null,
    expiresAt: extras.expiresAt ?? null,
    reason,
  }
}

function isTier(v: unknown): v is LicenseTier {
  return typeof v === 'string' && (LICENSE_TIERS as readonly string[]).includes(v)
}

function payloadOf(rec: Record<string, unknown>): LicensePayload | null {
  const { customer, tier, issuedAt, expiresAt, licenseId } = rec
  if (typeof customer !== 'string' || customer.trim() === '') return null
  if (!isTier(tier)) return null
  if (typeof issuedAt !== 'string' || typeof expiresAt !== 'string' || typeof licenseId !== 'string') return null
  if (!issuedAt || !expiresAt || !licenseId) return null
  return { customer, tier, issuedAt, expiresAt, licenseId }
}

export function licenseHash(payload: LicensePayload): string {
  const digest = createHash('sha256').update(canonicalize(payload)).digest('hex')
  return `sha256:${digest}`
}

/**
 * Verify a license file's contents against an Ed25519 public key (PEM).
 * Never throws for bad input — the MIT core stays usable.
 */
export function verifyLicense(fileContents: string, publicKeyPem: string): LicenseVerifyResult {
  if (typeof fileContents !== 'string' || fileContents.trim() === '') {
    return community('missing')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fileContents)
  } catch {
    return community('invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return community('invalid')
  }

  const rec = parsed as Record<string, unknown>
  const payload = payloadOf(rec)
  if (!payload) return community('invalid')

  const sig = rec.sig
  if (typeof sig !== 'object' || sig === null || Array.isArray(sig)) {
    return community('signature invalid')
  }
  const sigRec = sig as Record<string, unknown>
  if (sigRec.alg !== 'Ed25519' || typeof sigRec.value !== 'string' || !sigRec.value) {
    return community('signature invalid')
  }

  let publicKey
  try {
    publicKey = createPublicKey(publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return community('public key invalid')
    }
  } catch {
    return community('public key invalid')
  }

  const hash = licenseHash(payload)
  let ok = false
  try {
    ok = cryptoVerify(null, Buffer.from(hash, 'utf-8'), publicKey, Buffer.from(sigRec.value, 'base64'))
  } catch {
    ok = false
  }
  if (!ok) return community('signature invalid')

  const expMs = Date.parse(payload.expiresAt)
  if (!Number.isFinite(expMs)) {
    return community('invalid', { customer: payload.customer, expiresAt: payload.expiresAt })
  }
  if (expMs <= Date.now()) {
    return community('expired', { customer: payload.customer, expiresAt: payload.expiresAt })
  }

  return {
    valid: true,
    tier: payload.tier,
    customer: payload.customer,
    expiresAt: payload.expiresAt,
    reason: 'ok',
  }
}

/**
 * Test helper. Not a sales CLI — there is no `conarium-license` binary.
 * Signs with the same hash-then-Ed25519 construction receipts use.
 */
export function signLicense(payload: LicensePayload, privatePem: string, keyId: string): string {
  const privateKey = createPrivateKey(privatePem)
  const hash = licenseHash(payload)
  const value = cryptoSign(null, Buffer.from(hash, 'utf-8'), privateKey).toString('base64')
  const file: LicenseFile = {
    ...payload,
    sig: { alg: 'Ed25519', keyId, value },
  }
  return JSON.stringify(file)
}
