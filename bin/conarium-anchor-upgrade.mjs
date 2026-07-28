#!/usr/bin/env node
/**
 * conarium-anchor-upgrade — upgrade pending OpenTimestamps proofs toward Bitcoin.
 *
 * Usage: conarium-anchor-upgrade <anchors.jsonl>
 *
 * For each state:"pending" row, runs OpenTimestamps.upgrade(). On success refreshes
 * ots/state/bitcoinBlock/upgradedAt. If nothing changed, leaves the file untouched.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function hashPrefixToBuffer(hash) {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`bad hash: ${hash}`)
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new Error('hash must be 32 bytes')
  return buf
}

function loadRows(path) {
  if (!existsSync(path)) {
    console.error(`anchors file not found: ${path}`)
    process.exit(2)
  }
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: conarium-anchor-upgrade <anchors.jsonl>')
    process.exit(2)
  }

  let OpenTimestamps
  try {
    OpenTimestamps = require('javascript-opentimestamps')
    if (OpenTimestamps && OpenTimestamps.default) OpenTimestamps = OpenTimestamps.default
  } catch {
    console.error('javascript-opentimestamps is required')
    process.exit(2)
  }

  const rows = loadRows(path)
  let changedAny = false
  const out = []

  for (const row of rows) {
    if (row.state !== 'pending' || !row.ots || !row.hash) {
      out.push(row)
      continue
    }
    try {
      const hashBuf = hashPrefixToBuffer(row.hash)
      const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(),
        hashBuf,
      )
      const detachedOts = OpenTimestamps.DetachedTimestampFile.deserialize(
        Buffer.from(row.ots, 'base64'),
      )
      const changed = await OpenTimestamps.upgrade(detachedOts)
      if (!changed) {
        out.push(row)
        continue
      }
      const verified = await OpenTimestamps.verify(detachedOts, detached, {
        ignoreBitcoinNode: true,
        timeout: 15000,
      })
      const height = verified?.bitcoin?.height
      const next = {
        ...row,
        ots: Buffer.from(detachedOts.serializeToBytes()).toString('base64'),
        state: height != null ? 'bitcoin' : 'pending',
        bitcoinBlock: height ?? null,
        upgradedAt: new Date().toISOString(),
      }
      out.push(next)
      changedAny = true
      console.error(`[upgrade] seq=${row.seq} → ${next.state}${height != null ? ` block=${height}` : ''}`)
    } catch (err) {
      console.error(`[upgrade] seq=${row.seq} failed: ${err.message || err}`)
      out.push(row)
    }
  }

  if (!changedAny) {
    console.error('no upgrades applied (file untouched)')
    process.exit(0)
  }

  writeFileSync(path, out.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.error(`wrote ${path}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
