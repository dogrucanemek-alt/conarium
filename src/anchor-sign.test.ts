import { createPrivateKey, createPublicKey } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  countersignDigest,
  isServablePublicPem,
  signAnchorRecord,
  verifyAnchorRecord,
} from './anchor-sign.js'
import { generateKeyPair } from './keys.js'

function keys() {
  const pair = generateKeyPair('sign-test')
  return {
    signing: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) },
    verify: { keyId: pair.keyId, publicKey: createPublicKey(pair.publicPem) },
    publicPem: pair.publicPem,
    privatePem: pair.privatePem,
  }
}

describe('anchor countersign', () => {
  it('signs with receipt canonicalize and fails if one byte changes', () => {
    const { signing, verify } = keys()
    const signed = signAnchorRecord(
      { id: 'a', hash: 'sha256:' + 'ab'.repeat(32), owner: 'acme', seq: 1 },
      signing,
    )
    expect(signed.sig.alg).toBe('Ed25519')
    expect(signed.sig.keyId).toBe('sign-test')
    expect(verifyAnchorRecord(signed, verify)).toBe(true)

    const flipped = { ...signed, owner: 'globex' }
    expect(verifyAnchorRecord(flipped, verify)).toBe(false)
    expect(countersignDigest(signed)).toBe(countersignDigest({ ...signed, sig: { alg: 'Ed25519', keyId: 'x', value: 'y' } }))
  })

  it('refuses a private PEM the way the proof route does', () => {
    const { publicPem, privatePem } = keys()
    expect(isServablePublicPem(publicPem)).toBe(true)
    expect(isServablePublicPem(privatePem)).toBe(false)
    expect(isServablePublicPem('not a key')).toBe(false)
  })
})
