/**
 * Stamp / upgrade the demo /proof chain head. Not on the request path.
 *
 * Uses CORE's OpenTimestamps client (stampHash / upgradeProof). Writes:
 *   - <chain>.anchors.jsonl   — conarium-verify --anchor-check sidecar
 *   - CONARIUM_PROOF_ANCHOR_FILE (default sibling anchor.json)
 *   - last receipt.anchor     — hash-exterior; does not change chain.hash
 *
 * Usage:
 *   CONARIUM_PROOF_CHAIN=./deploy/proof/chain.jsonl \
 *   CONARIUM_PROOF_ANCHOR_FILE=./deploy/proof/anchor.json \
 *   CONARIUM_ROOT=/opt/conarium-mcp \
 *   node deploy/proof-anchor.mjs
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))

function coreRoot() {
  return process.env.CONARIUM_ROOT?.trim() || join(HERE, '..', '..', 'conarium-public')
}

async function loadCore() {
  const root = coreRoot()
  const { stampHash, upgradeProof } = await import(pathToFileURL(join(root, 'dist', 'ots', 'client.js')).href)
  const { hashPrefixToBuffer } = await import(pathToFileURL(join(root, 'dist', 'anchor.js')).href)
  return { stampHash, upgradeProof, hashPrefixToBuffer }
}

/**
 * Replace a file in one step. The /proof route hands chain.jsonl to visitors
 * while this runs; a truncating write can be read half-written, and a rename
 * has no partial state to read.
 */
function writeFileAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
}

function readReceipts(chainPath) {
  const raw = readFileSync(chainPath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  return lines.map((l) => JSON.parse(l))
}

function writeReceipts(chainPath, receipts) {
  writeFileAtomic(chainPath, receipts.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function lastHead(receipts) {
  const last = receipts[receipts.length - 1]
  const hash = last?.chain?.hash
  if (typeof hash !== 'string' || !hash.startsWith('sha256:')) {
    throw new Error('proof-anchor: last receipt has no chain.hash')
  }
  return { last, hash, seq: last.chain.seq }
}

/**
 * @param {object} opts
 * @param {string} opts.chainPath
 * @param {string} opts.anchorPath
 * @param {(digest: Buffer) => Promise<Buffer>} [opts.stamp]
 * @param {(ots: Buffer) => Promise<{ changed: boolean, otsBytes: Buffer, bitcoinBlock: number|null }>} [opts.upgrade]
 */
export async function stampDemoHead(opts) {
  const { stampHash, upgradeProof, hashPrefixToBuffer } = await loadCore()
  const stamp = opts.stamp ?? ((d) => stampHash(d, { timeoutMs: 30_000 }))
  const upgrade = opts.upgrade ?? ((ots) => upgradeProof(ots, { timeoutMs: 30_000 }))

  const receipts = readReceipts(opts.chainPath)
  if (receipts.length === 0) throw new Error('proof-anchor: empty chain')
  const { last, hash, seq } = lastHead(receipts)
  const sidecarPath = `${opts.chainPath}.anchors.jsonl`

  // Ask the file system once. A separate existence check is a second answer to
  // the same question, and the file can change between the two answers.
  let existing = null
  try {
    existing = JSON.parse(readFileSync(opts.anchorPath, 'utf8'))
  } catch {
    existing = null
  }

  const now = new Date().toISOString()
  let otsBase64 = typeof existing?.otsProof === 'string' ? existing.otsProof : null
  let state = existing?.state === 'bitcoin' ? 'bitcoin' : 'pending'
  let stampedAt = typeof existing?.stampedAt === 'string' ? existing.stampedAt : now
  let upgradedAt = existing?.upgradedAt ?? null

  if (existing?.ref && existing.ref !== hash) {
    // Head moved — previous stamp does not apply. Stamp the new head.
    otsBase64 = null
    state = 'pending'
    upgradedAt = null
    stampedAt = now
  }

  if (!otsBase64) {
    const otsBytes = await stamp(hashPrefixToBuffer(hash))
    otsBase64 = Buffer.isBuffer(otsBytes) ? otsBytes.toString('base64') : String(otsBytes)
    state = 'pending'
    stampedAt = now
  } else if (state === 'pending') {
    try {
      const up = await upgrade(Buffer.from(otsBase64, 'base64'))
      if (up.changed) {
        otsBase64 = up.otsBytes.toString('base64')
        if (up.bitcoinBlock != null) {
          state = 'bitcoin'
          upgradedAt = now
        }
      }
    } catch {
      // Calendar unreachable — keep pending. Do not invent bitcoin.
    }
  }

  const record = {
    log: 'opentimestamps',
    state,
    ref: hash,
    otsProof: otsBase64,
    stampedAt,
    upgradedAt,
  }
  writeFileAtomic(opts.anchorPath, JSON.stringify(record, null, 2) + '\n')

  const sidecar = {
    seq,
    hash,
    log: 'opentimestamps',
    ots: otsBase64,
    state,
    submittedAt: stampedAt,
    upgradedAt,
    bitcoinBlock: state === 'bitcoin' ? (existing?.bitcoinBlock ?? null) : null,
  }
  writeFileAtomic(sidecarPath, JSON.stringify(sidecar) + '\n')

  last.anchor = { log: 'opentimestamps', ref: hash, state }
  writeReceipts(opts.chainPath, receipts)

  return { ...record, sidecarPath }
}

async function main() {
  const chainPath = process.env.CONARIUM_PROOF_CHAIN?.trim() || join(HERE, 'proof', 'chain.jsonl')
  const anchorPath = process.env.CONARIUM_PROOF_ANCHOR_FILE?.trim() || join(HERE, 'proof', 'anchor.json')
  try {
    const out = await stampDemoHead({ chainPath, anchorPath })
    console.log(`ok: stamped ${out.ref} state=${out.state}`)
    console.log(`  anchor:  ${anchorPath}`)
    console.log(`  sidecar: ${out.sidecarPath}`)
    process.exit(0)
  } catch (err) {
    // Whether the chain is there is the read's answer to give, not a separate
    // question asked of the file system a moment earlier.
    if (err && err.code === 'ENOENT') {
      console.error(`proof-anchor: chain not readable: ${chainPath}`)
      process.exit(20)
    }
    console.error(`proof-anchor: ${err instanceof Error ? err.message : err}`)
    process.exit(50)
  }
}

const isDirect = process.argv[1] && process.argv[1].includes('proof-anchor')
if (isDirect) {
  main()
}
