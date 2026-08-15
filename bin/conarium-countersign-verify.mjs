#!/usr/bin/env node
/**
 * conarium-countersign-verify — independent offline verifier for a VERAX
 * countersign record.
 *
 * ZERO imports from src/. Canonicalization is duplicated here on purpose:
 * a third party must be able to run this single file without the Conarium package.
 *
 * Usage:
 *   conarium-countersign-verify <record.json> --pubkey <path>
 *       [--inclusion <proof.json>] [--log-url <url>]
 *
 * Exit codes (same class as conarium-verify):
 *   0   signature valid; inclusion valid if a proof or log URL was given
 *  13   signature invalid / no pubkey / unknown keyId
 *  14   inclusion proof present and false (record not in the claimed path)
 *  15   log COULD NOT BE CHECKED (URL unreachable) — not the same as 14
 *  20   schema invalid / file missing
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import { readFileSync, existsSync } from 'fs'

function canonicalize(obj) {
  return canonValue(obj)
}

function canonValue(v) {
  if (v === null) return 'null'
  if (v === undefined) {
    throw new Error('canonicalize: undefined is not allowed (omit the field)')
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number')
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return '[' + v.map(canonValue).join(',') + ']'
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
    const parts = []
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + canonValue(v[k]))
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalize: unsupported type ${typeof v}`)
}

function countersignDigest(record) {
  const copy = { ...record }
  delete copy.sig
  const digest = createHash('sha256').update(canonicalize(copy)).digest('hex')
  return `sha256:${digest}`
}

function decodeCanonicalBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  const buf = Buffer.from(s, 'base64')
  if (buf.toString('base64') !== s) return null
  return buf
}

function verifyHash(publicKey, hash, signatureBase64) {
  const sigBuf = decodeCanonicalBase64(signatureBase64)
  if (!sigBuf) return false
  try {
    return cryptoVerify(null, Buffer.from(hash, 'utf-8'), publicKey, sigBuf)
  } catch {
    return false
  }
}

function verifyInclusionProof(record, proof) {
  if (!proof || typeof proof !== 'object') return false
  if (proof.seq !== record.seq || proof.hash !== record.hash || proof.prevHash !== record.prevHash) {
    return false
  }
  if (!Array.isArray(proof.path) || proof.path.length === 0) return false
  if (proof.path[0].hash !== record.hash || proof.path[0].seq !== record.seq) return false
  let prev = record.prevHash
  for (const step of proof.path) {
    if (!step || step.prevHash !== prev) return false
    prev = step.hash
  }
  const last = proof.path[proof.path.length - 1]
  return last.hash === proof.head?.hash && last.seq === proof.head?.seq
}

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-countersign-verify <record.json> --pubkey <path> [--inclusion <proof.json>] [--log-url <url>]',
  )
}

function parseArgs(argv) {
  const out = { target: null, pubkey: null, inclusion: null, logUrl: null }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--pubkey') {
      const p = args.shift()
      if (!p) throw new Error('--pubkey requires a path')
      out.pubkey = p
    } else if (a === '--inclusion') {
      const p = args.shift()
      if (!p) throw new Error('--inclusion requires a path')
      out.inclusion = p
    } else if (a === '--log-url') {
      const p = args.shift()
      if (!p) throw new Error('--log-url requires a URL')
      out.logUrl = p
    } else if (a === '--help' || a === '-h') {
      usage()
      process.exit(0)
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`)
    } else if (!out.target) {
      out.target = a
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  return out
}

function fail(code, msg) {
  console.error(msg)
  process.exit(code)
}

function loadRecord(path) {
  if (!existsSync(path)) return { error: `path not found: ${path}`, code: 20 }
  let raw
  try {
    raw = readFileSync(path, 'utf-8').trim()
  } catch (err) {
    return { error: `cannot read ${path}: ${err.message}`, code: 20 }
  }
  // Whole file first: the usage line says <record.json>, and anyone who saves an
  // API response readably (`curl … | jq . > record.json`) has a pretty-printed
  // object whose first line is just "{". Parsing only that line rejected valid
  // JSON with "invalid JSON" — the instruction failing for the natural form of
  // its own documented input. The single-line path stays for a store line
  // lifted straight out of the JSONL log.
  let rec
  try {
    rec = JSON.parse(raw)
  } catch {
    try {
      rec = JSON.parse(raw.split('\n')[0])
    } catch (err) {
      return { error: `invalid JSON: ${err.message}`, code: 20 }
    }
  }
  if (!rec || typeof rec !== 'object') return { error: 'record must be an object', code: 20 }
  if (rec.type !== 'submit' && rec.type !== 'upgrade') {
    return { error: 'schema: type must be submit or upgrade', code: 20 }
  }
  if (typeof rec.id !== 'string' || !rec.id) return { error: 'schema: missing id', code: 20 }
  if (typeof rec.digest !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/.test(rec.digest)) {
    return { error: 'schema: digest must be sha256:<64 hex>', code: 20 }
  }
  if (typeof rec.hash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.hash)) {
    return { error: 'schema: hash must be 64 hex chars (entry hash)', code: 20 }
  }
  if (!Number.isInteger(rec.seq) || rec.seq < 1) return { error: 'schema: seq must be an integer >= 1', code: 20 }
  if (typeof rec.prevHash !== 'string' || !rec.prevHash) {
    return { error: 'schema: missing prevHash', code: 20 }
  }
  const sig = rec.sig
  if (!sig || sig.alg !== 'Ed25519' || typeof sig.keyId !== 'string' || typeof sig.value !== 'string') {
    return { error: 'schema: sig must be { alg: Ed25519, keyId, value }', code: 20 }
  }
  return { rec }
}

function loadPubkey(path) {
  if (!path) return { error: 'no --pubkey given (refusing to skip signature checks)', code: 13 }
  if (!existsSync(path)) return { error: `public key not found: ${path}`, code: 13 }
  let pem
  try {
    pem = readFileSync(path, 'utf-8')
  } catch (err) {
    return { error: `cannot read public key ${path}: ${err.message}`, code: 13 }
  }
  let publicKey
  try {
    publicKey = createPublicKey(pem)
  } catch (err) {
    return { error: `invalid public PEM ${path}: ${err.message}`, code: 13 }
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return { error: `expected Ed25519 at ${path}, got ${publicKey.asymmetricKeyType}`, code: 13 }
  }
  const sidecar = `${path}.keyid`
  if (!existsSync(sidecar)) return { error: `missing keyId sidecar: ${sidecar}`, code: 13 }
  const keyId = readFileSync(sidecar, 'utf-8').trim()
  if (!keyId) return { error: `empty keyId sidecar: ${sidecar}`, code: 13 }
  return { publicKey, keyId }
}

function loadInclusion(path) {
  if (!existsSync(path)) return { error: `inclusion file not found: ${path}`, code: 20 }
  try {
    return { proof: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch (err) {
    return { error: `invalid inclusion JSON: ${err.message}`, code: 20 }
  }
}

async function fetchInclusion(url) {
  let res
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    return { error: `log could not be checked: ${err.message}`, code: 15 }
  }
  if (!res.ok) {
    return { error: `log could not be checked: HTTP ${res.status}`, code: 15 }
  }
  let body
  try {
    body = await res.json()
  } catch (err) {
    return { error: `log could not be checked: ${err.message}`, code: 15 }
  }
  if (!body || typeof body !== 'object' || !body.inclusion) {
    return { error: 'inclusion proof missing from log response', code: 14 }
  }
  return { proof: body.inclusion }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    usage(err.message)
    process.exit(20)
  }
  if (!opts.target) {
    usage('missing record.json')
    process.exit(20)
  }

  const loaded = loadRecord(opts.target)
  if (loaded.error) fail(loaded.code, loaded.error)
  const rec = loaded.rec

  const key = loadPubkey(opts.pubkey)
  if (key.error) fail(key.code, key.error)
  if (rec.sig.keyId !== key.keyId) {
    fail(13, `signature keyId ${rec.sig.keyId} is not in the provided pubkey set`)
  }
  if (!verifyHash(key.publicKey, countersignDigest(rec), rec.sig.value)) {
    fail(13, 'signature invalid')
  }

  let proof = null
  if (opts.inclusion) {
    const inc = loadInclusion(opts.inclusion)
    if (inc.error) fail(inc.code, inc.error)
    proof = inc.proof
  }
  if (opts.logUrl) {
    const fetched = await fetchInclusion(opts.logUrl)
    if (fetched.error) fail(fetched.code, fetched.error)
    proof = fetched.proof
  }
  if (proof) {
    if (!verifyInclusionProof(rec, proof)) {
      fail(14, 'inclusion proof does not place this record in the claimed log')
    }
  }

  console.log(`ok  countersign ${rec.id} seq ${rec.seq} keyId ${rec.sig.keyId}`)
  process.exit(0)
}

main().catch((err) => fail(15, `could not be checked: ${err.message}`))
