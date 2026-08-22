#!/usr/bin/env node
/**
 * conarium-stamp — timestamp a document to OpenTimestamps.
 *
 * Receipts are not anchored by the write path. Documents — a specification, a policy
 * file, a coverage declaration, a prior-art scan — are stamped here, and a git commit date
 * is not evidence: `git commit --date` accepts anything you type.
 *
 * This stamps the SHA-256 of a file to the OpenTimestamps calendars and writes a
 * sidecar next to it. Upgrade later with `conarium-anchor-upgrade` to get the
 * Bitcoin block height.
 *
 * What a stamp proves: the file existed, in exactly this form, no later than the
 * anchored time. It does NOT prove the file is correct, nor that nobody wrote
 * something similar earlier — only that ours is not backdated.
 *
 * Only the 32-byte digest leaves the machine. The file content never does.
 *
 * Usage:
 *   conarium-stamp <file> [--sidecar <path>] [--json]
 *
 * Exit codes (documented in docs/RECEIPT-SPEC.md):
 *   0   stamped, sidecar written (state: pending until upgraded)
 *   20  input invalid (file missing/unreadable, bad flag)
 *   50  stamping failed (calendars unreachable or timed out)
 */
import { createHash } from 'crypto'
import { readFileSync, existsSync, appendFileSync } from 'fs'
import { stampHash } from '../dist/ots/client.js'

const STAMP_TIMEOUT_MS = 30_000

function usage(msg) {
  if (msg) console.error(msg)
  console.error('Usage: conarium-stamp <file> [--sidecar <path>] [--json]')
}

function parseArgs(argv) {
  const out = { target: null, sidecar: null, json: false }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--sidecar') {
      out.sidecar = args.shift() ?? null
      if (!out.sidecar) throw new Error('--sidecar requires a path')
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

async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    usage(err.message)
    process.exit(2)
  }
  if (!opts.target) {
    usage('missing <file>')
    process.exit(2)
  }
  if (!existsSync(opts.target)) {
    console.error(`file not found: ${opts.target}`)
    process.exit(2)
  }

  let content
  try {
    content = readFileSync(opts.target)
  } catch (err) {
    console.error(`cannot read ${opts.target}: ${err.message}`)
    process.exit(2)
  }

  const digest = createHash('sha256').update(content).digest()
  const hash = `sha256:${digest.toString('hex')}`
  const sidecarPath = opts.sidecar ?? `${opts.target}.anchors.jsonl`

  let otsBase64
  const submittedAt = new Date().toISOString()
  try {
    const otsBytes = await Promise.race([
      stampHash(digest, { timeoutMs: STAMP_TIMEOUT_MS }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`stamp timed out after ${STAMP_TIMEOUT_MS}ms`)), STAMP_TIMEOUT_MS),
      ),
    ])
    otsBase64 = otsBytes.toString('base64')
  } catch (err) {
    console.error(`stamping failed: ${err.message}`)
    process.exit(50)
  }

  // Same sidecar shape the receipt anchoring writes, so conarium-anchor-upgrade
  // works on it unchanged.
  //
  // A revised document is stamped again and appended: the earlier row keeps proving
  // the earlier revision existed, and the new row proves the current one. Sequence
  // continues from what is already in the sidecar — two rows both claiming seq 1
  // would misreport the order of revisions.
  const priorRows = existsSync(sidecarPath)
    ? readFileSync(sidecarPath, 'utf-8').split('\n').filter((l) => l.trim()).length
    : 0
  const record = {
    seq: priorRows + 1,
    hash,
    log: 'opentimestamps',
    ots: otsBase64,
    state: 'pending',
    submittedAt,
    document: opts.target,
  }
  appendFileSync(sidecarPath, JSON.stringify(record) + '\n')

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, code: 0, ...record, ots: `<${otsBase64.length} base64 chars>` }))
  } else {
    console.log(`ok: stamped ${opts.target}`)
    console.log(`  digest:  ${hash}`)
    console.log(`  sidecar: ${sidecarPath} (${otsBase64.length} base64 chars)`)
    console.log(`  state:   pending — Bitcoin confirmation takes hours;`)
    console.log(`           run conarium-anchor-upgrade ${sidecarPath} later for the block height`)
    console.error(
      'note: a stamp proves this file existed in this exact form no later than the anchored time. ' +
        'It does not prove the file is correct, nor that no one published something similar earlier.',
    )
  }
  process.exit(0)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('conarium-stamp.mjs') || process.argv[1].endsWith('conarium-stamp'))

if (isDirect) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
