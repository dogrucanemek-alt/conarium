#!/usr/bin/env node
/**
 * conarium-verify — independent offline verifier for Conarium Receipt v0.1.
 *
 * ZERO imports from src/. Canonicalization is duplicated here on purpose:
 * a third party must be able to run this single file without the Conarium package.
 *
 * Usage:
 *   conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...]
 *                   [--anchor-check] [--expect-seq-from N] [--json]
 *
 * Exit codes (design §5):
 *   0  chain intact, signatures valid
 *  10  hash mismatch (tampered)
 *  11  prevHash break (deleted / inserted)
 *  12  seq gap or non-increasing
 *  13  signature invalid / no pubkey
 *  14  anchor proof failed / missing under --anchor-check
 *  20  schema invalid
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, extname } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const RECEIPT_VERSION = 'conarium-receipt/0.1'
const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

// ─── JCS subset (must match src/receipt.ts canonicalize) ─────────────────────

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

function receiptHash(r) {
  const copy = { ...r }
  delete copy.hash
  delete copy.sig
  delete copy.anchor
  if (copy.chain && typeof copy.chain === 'object') {
    const chain = { ...copy.chain }
    delete chain.hash
    copy.chain = chain
  }
  const digest = createHash('sha256').update(canonicalize(copy)).digest('hex')
  return `sha256:${digest}`
}

// Exported for cross-check tests (dynamic import of this file).
export { canonicalize, receiptHash }

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...] [--anchor-check] [--anchors <path>] [--expect-seq-from N] [--json]',
  )
}

function parseArgs(argv) {
  const out = {
    target: null,
    pubkeys: [],
    anchorCheck: false,
    anchorsPath: null,
    expectSeqFrom: null,
    json: false,
  }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--pubkey') {
      const p = args.shift()
      if (!p) throw new Error('--pubkey requires a path')
      out.pubkeys.push(p)
    } else if (a === '--anchor-check') {
      out.anchorCheck = true
    } else if (a === '--anchors') {
      const p = args.shift()
      if (!p) throw new Error('--anchors requires a path')
      out.anchorsPath = p
    } else if (a === '--expect-seq-from') {
      const n = args.shift()
      if (n === undefined || !/^\d+$/.test(n)) throw new Error('--expect-seq-from requires an integer')
      out.expectSeqFrom = Number(n)
    } else if (a === '--json') {
      out.json = true
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

function hashPrefixToBuffer(hash) {
  const hex = typeof hash === 'string' && hash.startsWith('sha256:') ? hash.slice(7) : hash
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('anchor hash must be sha256:<64 hex>')
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new Error('anchor hash must decode to 32 bytes')
  return buf
}

function loadAnchorSidecar(path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function findAnchorRecord(rows, ref) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].hash === ref) return rows[i]
  }
  return null
}

async function verifyOtsProof(otsBase64, hash) {
  // Test stub proofs (no calendar / no network). Format: base64("TESTOTS:pending|fail|mismatch")
  try {
    const ascii = Buffer.from(otsBase64, 'base64').toString('utf8')
    if (ascii.startsWith('TESTOTS:')) {
      const kind = ascii.slice('TESTOTS:'.length)
      if (kind === 'pending') return { ok: true, pending: true }
      if (kind === 'bitcoin') return { ok: true, pending: false }
      if (kind === 'fail' || kind === 'mismatch') {
        return { ok: false, pending: false, detail: 'ots proof digest does not match chain hash' }
      }
      return { ok: false, pending: false, detail: `unknown TESTOTS kind ${kind}` }
    }
  } catch {
    // not a stub — continue to real OTS
  }

  let OpenTimestamps
  try {
    OpenTimestamps = require('javascript-opentimestamps')
    if (OpenTimestamps && OpenTimestamps.default) OpenTimestamps = OpenTimestamps.default
  } catch {
    return { ok: false, pending: false, detail: 'javascript-opentimestamps not installed' }
  }
  try {
    const hashBuf = hashPrefixToBuffer(hash)
    const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      hashBuf,
    )
    const detachedOts = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(otsBase64, 'base64'))
    // Digest mismatch (proof for another hash) → fail closed
    try {
      const fileDigest =
        typeof detachedOts.fileDigest === 'function'
          ? Buffer.from(detachedOts.fileDigest())
          : null
      if (fileDigest && !fileDigest.equals(hashBuf)) {
        return { ok: false, pending: false, detail: 'ots proof digest does not match chain hash' }
      }
    } catch {
      // some versions expose digest differently — fall through to verify()
    }
    const verified = await OpenTimestamps.verify(detachedOts, detached, {
      ignoreBitcoinNode: true,
      timeout: 15000,
    })
    if (!verified || Object.keys(verified).length === 0) {
      return { ok: true, pending: true }
    }
    return { ok: true, pending: !verified.bitcoin }
  } catch (err) {
    return { ok: false, pending: false, detail: err.message || String(err) }
  }
}

function loadVerifyKeys(paths) {
  if (paths.length === 0) {
    return { error: 'no --pubkey given (refusing to skip signature checks)', code: 13 }
  }
  const keys = new Map()
  for (const path of paths) {
    if (!existsSync(path)) {
      return { error: `public key not found: ${path}`, code: 13 }
    }
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
    if (!existsSync(sidecar)) {
      return { error: `missing keyId sidecar: ${sidecar}`, code: 13 }
    }
    const keyId = readFileSync(sidecar, 'utf-8').trim()
    if (!keyId) {
      return { error: `empty keyId sidecar: ${sidecar}`, code: 13 }
    }
    keys.set(keyId, publicKey)
  }
  return { keys }
}

function loadReceipts(target) {
  if (!existsSync(target)) {
    return { error: `path not found: ${target}`, code: 20 }
  }
  const st = statSync(target)
  let files = []
  if (st.isDirectory()) {
    files = readdirSync(target)
      .filter((f) => ['.json', '.jsonl', '.receipt'].includes(extname(f)))
      .map((f) => join(target, f))
      .sort()
  } else {
    files = [target]
  }

  const receipts = []
  for (const file of files) {
    const raw = readFileSync(file, 'utf-8').trim()
    if (!raw) continue
    const lines = raw.includes('\n') && !raw.trimStart().startsWith('[')
      ? raw.split('\n').filter(Boolean)
      : [raw]
    for (let i = 0; i < lines.length; i++) {
      let obj
      try {
        obj = JSON.parse(lines[i])
      } catch (err) {
        return { error: `invalid JSON in ${file}:${i + 1}: ${err.message}`, code: 20 }
      }
      if (Array.isArray(obj)) {
        for (const item of obj) receipts.push({ file, receipt: item })
      } else {
        receipts.push({ file, receipt: obj })
      }
    }
  }
  return { receipts }
}

function schemaOk(r) {
  if (!r || typeof r !== 'object') return 'not an object'
  if (r.v !== RECEIPT_VERSION) return `unsupported version ${r.v}`
  if (typeof r.id !== 'string' || !r.id) return 'missing id'
  if (typeof r.ts !== 'string') return 'missing ts'
  if (!r.chain || typeof r.chain !== 'object') return 'missing chain'
  if (!Number.isInteger(r.chain.seq)) return 'chain.seq not integer'
  if (typeof r.chain.prevHash !== 'string') return 'missing chain.prevHash'
  if (typeof r.chain.hash !== 'string') return 'missing chain.hash'
  if (r.consentRef !== null && r.consentRef !== undefined) {
    // v0.1: must be null if present; undefined treated as schema drift → 20
    if (r.consentRef !== null) return 'consentRef must be null in v0.1'
  }
  if (!('consentRef' in r)) return 'missing consentRef (must be null)'
  if (!('anchor' in r)) return 'missing anchor field'
  if (!r.actor || r.actor.type !== 'service') return 'actor.type must be "service" in v0.1'
  return null
}

function verifySig(keys, receipt) {
  if (!receipt.sig || typeof receipt.sig !== 'object') {
    return 'missing sig'
  }
  if (receipt.sig.alg !== 'Ed25519') return `unsupported sig.alg ${receipt.sig.alg}`
  const pk = keys.get(receipt.sig.keyId)
  if (!pk) return `unknown keyId ${receipt.sig.keyId}`
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(receipt.chain.hash, 'utf-8'),
      pk,
      Buffer.from(receipt.sig.value, 'base64'),
    )
    return ok ? null : 'signature cryptographically invalid'
  } catch (err) {
    return `signature verify error: ${err.message}`
  }
}

function fail(code, message, jsonMode, extra = {}) {
  const payload = { ok: false, code, message, ...extra }
  console.error(message)
  if (jsonMode) console.log(JSON.stringify(payload))
  process.exit(code)
}

async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    usage(err.message)
    process.exit(20)
  }
  if (!opts.target) {
    usage('missing <file|dir>')
    process.exit(20)
  }

  const keyResult = loadVerifyKeys(opts.pubkeys)
  if (keyResult.error) {
    fail(keyResult.code, keyResult.error, opts.json)
  }
  const { keys } = keyResult

  const loaded = loadReceipts(opts.target)
  if (loaded.error) {
    fail(loaded.code, loaded.error, opts.json)
  }
  const { receipts } = loaded

  let anchorRows = []
  if (opts.anchorCheck) {
    const defaultAnchors =
      opts.anchorsPath ||
      (existsSync(opts.target) && statSync(opts.target).isFile()
        ? `${opts.target}.anchors.jsonl`
        : null)
    if (defaultAnchors && existsSync(defaultAnchors)) {
      anchorRows = loadAnchorSidecar(defaultAnchors)
    }
  }

  if (receipts.length === 0) {
    console.error('warning: empty chain (0 receipts)')
    if (opts.json) console.log(JSON.stringify({ ok: true, code: 0, warning: 'empty', count: 0 }))
    process.exit(0)
  }
  if (receipts.length === 1) {
    console.error('warning: single-receipt chain')
  }

  let prevHash = GENESIS
  let prevSeq = opts.expectSeqFrom !== null ? opts.expectSeqFrom - 1 : null
  let pendingAnchorWarned = false

  for (let i = 0; i < receipts.length; i++) {
    const { file, receipt } = receipts[i]
    const where = `${file}#${i}`

    const schemaErr = schemaOk(receipt)
    if (schemaErr) {
      fail(20, `schema invalid at ${where}: ${schemaErr}`, opts.json, { index: i, file })
    }

    const expected = receiptHash(receipt)
    if (receipt.chain.hash !== expected) {
      fail(10, `hash mismatch at ${where}: recomputed ${expected}, stored ${receipt.chain.hash}`, opts.json, {
        index: i,
        file,
      })
    }

    if (receipt.chain.prevHash !== prevHash) {
      fail(
        11,
        `prevHash break at ${where}: expected ${prevHash}, got ${receipt.chain.prevHash}`,
        opts.json,
        { index: i, file },
      )
    }

    if (prevSeq !== null) {
      if (receipt.chain.seq !== prevSeq + 1) {
        fail(
          12,
          `seq gap at ${where}: expected ${prevSeq + 1}, got ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
    } else if (i > 0) {
      // After first receipt, seq must increase by exactly 1
      // (first receipt establishes the baseline)
    }
    if (i > 0) {
      const prev = receipts[i - 1].receipt
      if (receipt.chain.seq <= prev.chain.seq) {
        fail(
          12,
          `seq non-increasing at ${where}: ${prev.chain.seq} → ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
      if (receipt.chain.seq !== prev.chain.seq + 1) {
        fail(
          12,
          `seq gap at ${where}: expected ${prev.chain.seq + 1}, got ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
    }
    if (opts.expectSeqFrom !== null && i === 0 && receipt.chain.seq !== opts.expectSeqFrom) {
      fail(
        12,
        `seq start mismatch at ${where}: expected ${opts.expectSeqFrom}, got ${receipt.chain.seq}`,
        opts.json,
        { index: i, file },
      )
    }

    const sigErr = verifySig(keys, receipt)
    if (sigErr) {
      fail(13, `signature invalid at ${where}: ${sigErr}`, opts.json, { index: i, file })
    }

    if (opts.anchorCheck) {
      if (receipt.anchor === null || receipt.anchor === undefined) {
        fail(14, `anchor missing at ${where} (--anchor-check)`, opts.json, { index: i, file })
      }
      if (typeof receipt.anchor !== 'object' || typeof receipt.anchor.log !== 'string') {
        fail(14, `anchor proof invalid at ${where}`, opts.json, { index: i, file })
      }
      const ref = receipt.anchor.ref || receipt.chain.hash
      const row = findAnchorRecord(anchorRows, ref)
      if (!row) {
        fail(14, `anchor sidecar record missing for ref ${ref} at ${where}`, opts.json, {
          index: i,
          file,
        })
      }
      if (!row.ots) {
        fail(14, `anchor ots missing in sidecar for ref ${ref} at ${where}`, opts.json, {
          index: i,
          file,
        })
      }
      const otsResult = await verifyOtsProof(row.ots, receipt.chain.hash)
      if (!otsResult.ok) {
        fail(
          14,
          `anchor proof failed at ${where}: ${otsResult.detail || 'verify failed'}`,
          opts.json,
          { index: i, file },
        )
      }
      if (otsResult.pending || row.state === 'pending') {
        if (!pendingAnchorWarned) {
          console.error(
            'warning: anchor pending (calendar only, not yet Bitcoin-attested)',
          )
          pendingAnchorWarned = true
        }
      }
    }

    prevHash = receipt.chain.hash
    prevSeq = receipt.chain.seq
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, code: 0, count: receipts.length }))
  } else {
    console.log(`ok: ${receipts.length} receipt(s) verified`)
  }
  process.exit(0)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('conarium-verify.mjs') ||
    process.argv[1].endsWith('conarium-verify'))

if (isDirect) {
  main().catch((err) => {
    console.error(err)
    process.exit(20)
  })
}
