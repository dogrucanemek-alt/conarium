/**
 * Ed25519 signing-key management for Conarium Receipts.
 *
 * keyId storage: sidecar file next to the key PEM.
 *   private:  /path/audit-ed25519.pem
 *   keyId:    /path/audit-ed25519.pem.keyid   (UTF-8, trimmed single line)
 *   public:   (any path; verify loads path + path+".keyid")
 *
 * Env:
 *   CONARIUM_AUDIT_SIGNING_KEY   — path to Ed25519 private PEM
 *   CONARIUM_AUDIT_KEY_ID        — optional override; else read sidecar
 *   CONARIUM_AUDIT_TRUST_PUBKEYS — comma/semicolon-separated public PEM paths
 *                                  (each needs a sibling `.keyid`); forms the
 *                                  multi-keyId trust store together with the
 *                                  current signing key's derived public key
 *   CONARIUM_ANCHOR_SIGNING_KEY  — same shape, for the countersign service
 *   CONARIUM_ANCHOR_KEY_ID       — optional override; else read sidecar
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'crypto'
import { readFileSync, existsSync, statSync, writeFileSync, chmodSync } from 'fs'
import { platform } from 'os'

export type KeyId = string

export interface SigningKey {
  keyId: KeyId
  privateKey: KeyObject
}

export interface VerifyKey {
  keyId: KeyId
  publicKey: KeyObject
}

export function generateKeyPair(keyId: KeyId): { privatePem: string; publicPem: string; keyId: KeyId } {
  if (!keyId || typeof keyId !== 'string') {
    throw new Error('generateKeyPair: keyId must be a non-empty string')
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    keyId,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

/** Write PEMs + .keyid sidecar. Sets 0600 on POSIX for the private key. */
export function writeKeyPairFiles(
  dirBase: string,
  keyId: KeyId,
): { privatePath: string; publicPath: string; keyIdPath: string; publicKeyIdPath: string } {
  const pair = generateKeyPair(keyId)
  const privatePath = `${dirBase}.pem`
  const publicPath = `${dirBase}.pub.pem`
  const keyIdPath = `${privatePath}.keyid`
  const publicKeyIdPath = `${publicPath}.keyid`
  writeFileSync(privatePath, pair.privatePem, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  writeFileSync(publicPath, pair.publicPem, { encoding: 'utf-8', flag: 'wx' })
  writeFileSync(keyIdPath, keyId + '\n', { encoding: 'utf-8', flag: 'wx' })
  writeFileSync(publicKeyIdPath, keyId + '\n', { encoding: 'utf-8', flag: 'wx' })
  if (platform() !== 'win32') {
    chmodSync(privatePath, 0o600)
  }
  return { privatePath, publicPath, keyIdPath, publicKeyIdPath }
}

function readKeyIdSidecar(pemPath: string): KeyId | null {
  const sidecar = `${pemPath}.keyid`
  if (!existsSync(sidecar)) return null
  const raw = readFileSync(sidecar, 'utf-8').trim()
  return raw.length > 0 ? raw : null
}

/** POSIX only. win32 modes are meaningless — never fail-closed there. */
export function assertPrivateKeyMode(
  path: string,
  mode: number,
  opts: { platform?: NodeJS.Platform; allowLoose?: boolean } = {},
): void {
  const plat = opts.platform ?? platform()
  if (plat === 'win32') return
  const bits = mode & 0o777
  if ((bits & 0o077) === 0) return
  const allow = opts.allowLoose ?? process.env.CONARIUM_ALLOW_LOOSE_KEY_PERMS === '1'
  const msg = `[conarium:keys] ${path} mode is ${bits.toString(8)} (expected 0600); private key may be readable by others`
  if (allow) {
    console.warn(msg)
    return
  }
  throw new Error(`${msg}. Set CONARIUM_ALLOW_LOOSE_KEY_PERMS=1 to continue.`)
}

function assertKeyFilePerms(path: string): void {
  if (platform() === 'win32') return
  try {
    assertPrivateKeyMode(path, statSync(path).mode)
  } catch (err) {
    if (err instanceof Error && /expected 0600/.test(err.message)) throw err
    // ignore — load will fail separately if unreadable
  }
}

export function loadSigningKeyFrom(
  path: string,
  opts: { keyId?: string; pathEnv?: string; keyIdEnv?: string } = {},
): SigningKey {
  const pathEnv = opts.pathEnv ?? 'CONARIUM_AUDIT_SIGNING_KEY'
  const keyIdEnv = opts.keyIdEnv ?? 'CONARIUM_AUDIT_KEY_ID'
  if (!existsSync(path)) {
    throw new Error(`loadSigningKey: ${pathEnv} file not found: ${path}`)
  }
  assertKeyFilePerms(path)
  let pem: string
  try {
    pem = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(`loadSigningKey: cannot read private key at ${path}: ${(err as Error).message}`)
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(pem)
  } catch (err) {
    throw new Error(`loadSigningKey: invalid Ed25519 private PEM at ${path}: ${(err as Error).message}`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`loadSigningKey: expected Ed25519 key, got ${privateKey.asymmetricKeyType ?? 'unknown'} at ${path}`)
  }
  const keyId = opts.keyId?.trim() || readKeyIdSidecar(path)
  if (!keyId) {
    throw new Error(`loadSigningKey: missing keyId — set ${keyIdEnv} or create ${path}.keyid`)
  }
  return { keyId, privateKey }
}

export function loadSigningKey(): SigningKey | null {
  const path = process.env.CONARIUM_AUDIT_SIGNING_KEY
  if (!path) return null
  return loadSigningKeyFrom(path, {
    keyId: process.env.CONARIUM_AUDIT_KEY_ID,
    pathEnv: 'CONARIUM_AUDIT_SIGNING_KEY',
    keyIdEnv: 'CONARIUM_AUDIT_KEY_ID',
  })
}

/** Anchor / countersign key. Unlike the audit loader, missing env is an error. */
export function loadAnchorSigningKey(): SigningKey {
  const path = process.env.CONARIUM_ANCHOR_SIGNING_KEY
  if (!path) {
    throw new Error('loadAnchorSigningKey: missing CONARIUM_ANCHOR_SIGNING_KEY')
  }
  return loadSigningKeyFrom(path, {
    keyId: process.env.CONARIUM_ANCHOR_KEY_ID,
    pathEnv: 'CONARIUM_ANCHOR_SIGNING_KEY',
    keyIdEnv: 'CONARIUM_ANCHOR_KEY_ID',
  })
}

export function loadVerifyKeys(paths: string[]): VerifyKey[] {
  if (paths.length === 0) {
    throw new Error('loadVerifyKeys: at least one public-key path is required')
  }
  const out: VerifyKey[] = []
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(`loadVerifyKeys: public key file not found: ${path}`)
    }
    let pem: string
    try {
      pem = readFileSync(path, 'utf-8')
    } catch (err) {
      throw new Error(`loadVerifyKeys: cannot read public key at ${path}: ${(err as Error).message}`)
    }
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(pem)
    } catch (err) {
      throw new Error(`loadVerifyKeys: invalid public PEM at ${path}: ${(err as Error).message}`)
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `loadVerifyKeys: expected Ed25519 key, got ${publicKey.asymmetricKeyType ?? 'unknown'} at ${path}`,
      )
    }
    const keyId = readKeyIdSidecar(path)
    if (!keyId) {
      throw new Error(`loadVerifyKeys: missing keyId sidecar ${path}.keyid`)
    }
    out.push({ keyId, publicKey })
  }
  return out
}

export function signHash(key: SigningKey, hash: string): string {
  const sig = cryptoSign(null, Buffer.from(hash, 'utf-8'), key.privateKey)
  return sig.toString('base64')
}

function decodeCanonicalBase64(s: string): Buffer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  const buf = Buffer.from(s, 'base64')
  if (buf.toString('base64') !== s) return null
  return buf
}

export function verifyHash(key: VerifyKey, hash: string, signatureBase64: string): boolean {
  const sigBuf = decodeCanonicalBase64(signatureBase64)
  if (!sigBuf) return false
  try {
    return cryptoVerify(null, Buffer.from(hash, 'utf-8'), key.publicKey, sigBuf)
  } catch {
    return false
  }
}

/** Parse CONARIUM_AUDIT_TRUST_PUBKEYS (`,` or `;` separated). Empty → []. */
export function parseTrustPubkeyPaths(envValue: string | undefined = process.env.CONARIUM_AUDIT_TRUST_PUBKEYS): string[] {
  if (!envValue) return []
  return envValue
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * Trust store for validateChain / rotation:
 * current signing key (derived public) + CONARIUM_AUDIT_TRUST_PUBKEYS.
 * Map is keyed by keyId; later paths override earlier ones for the same id.
 */
export function loadTrustStore(signingKey: SigningKey | null = null): Map<KeyId, VerifyKey> {
  const map = new Map<KeyId, VerifyKey>()
  if (signingKey) {
    map.set(signingKey.keyId, {
      keyId: signingKey.keyId,
      publicKey: createPublicKey(signingKey.privateKey),
    })
  }
  const extraPaths = parseTrustPubkeyPaths()
  if (extraPaths.length > 0) {
    for (const vk of loadVerifyKeys(extraPaths)) {
      map.set(vk.keyId, vk)
    }
  }
  return map
}
