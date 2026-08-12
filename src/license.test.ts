import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signLicense, verifyLicense, type LicensePayload } from './license.js'

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    customer: 'Acme Bank',
    tier: 'pro',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    licenseId: 'lic-test-1',
    ...overrides,
  }
}

describe('verifyLicense', () => {
  it('a valid signed license reports its tier', () => {
    const { privatePem, publicPem } = pair()
    const file = signLicense(payload({ tier: 'business' }), privatePem, 'k1')
    const r = verifyLicense(file, publicPem)
    expect(r.valid).toBe(true)
    expect(r.tier).toBe('business')
    expect(r.customer).toBe('Acme Bank')
    expect(r.expiresAt).toBe('2099-01-01T00:00:00.000Z')
    expect(r.reason).toBe('ok')
  })

  it('an expired license is community, with reason expired', () => {
    const { privatePem, publicPem } = pair()
    const file = signLicense(
      payload({ expiresAt: '2020-01-01T00:00:00.000Z' }),
      privatePem,
      'k1',
    )
    const r = verifyLicense(file, publicPem)
    expect(r.valid).toBe(false)
    expect(r.tier).toBe('community')
    expect(r.reason).toBe('expired')
    expect(r.customer).toBe('Acme Bank')
    expect(r.expiresAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('flipping one byte of the signature is community + signature invalid', () => {
    const { privatePem, publicPem } = pair()
    const file = JSON.parse(signLicense(payload(), privatePem, 'k1'))
    const raw = Buffer.from(file.sig.value, 'base64')
    raw[0] = raw[0] ^ 0xff
    file.sig.value = raw.toString('base64')
    const r = verifyLicense(JSON.stringify(file), publicPem)
    expect(r.valid).toBe(false)
    expect(r.tier).toBe('community')
    expect(r.reason).toBe('signature invalid')
  })

  it('missing file contents is community and does not throw', () => {
    const { publicPem } = pair()
    expect(() => verifyLicense('', publicPem)).not.toThrow()
    const r = verifyLicense('', publicPem)
    expect(r.valid).toBe(false)
    expect(r.tier).toBe('community')
    expect(r.reason).toBe('missing')
  })
})
