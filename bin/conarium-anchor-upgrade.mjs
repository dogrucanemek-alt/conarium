#!/usr/bin/env node
/**
 * conarium-anchor-upgrade — upgrade pending OpenTimestamps proofs toward Bitcoin.
 *
 * Usage: conarium-anchor-upgrade <anchors.jsonl>
 *
 * For each state:"pending" row, asks the calendars for a fuller proof.
 * On success refreshes ots/state/bitcoinBlock/upgradedAt.
 * If nothing changed, leaves the file untouched.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { upgradeProof } from '../dist/ots/client.js'

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

  const rows = loadRows(path)
  let changedAny = false
  const out = []

  for (const row of rows) {
    if (row.state !== 'pending' || !row.ots || !row.hash) {
      out.push(row)
      continue
    }
    try {
      const up = await upgradeProof(Buffer.from(row.ots, 'base64'))
      if (!up.changed) {
        out.push(row)
        continue
      }
      const next = {
        ...row,
        ots: up.otsBytes.toString('base64'),
        state: up.bitcoinBlock != null ? 'bitcoin' : 'pending',
        bitcoinBlock: up.bitcoinBlock,
        upgradedAt: new Date().toISOString(),
      }
      out.push(next)
      changedAny = true
      console.error(`[upgrade] seq=${row.seq} → ${next.state}${up.bitcoinBlock != null ? ` block=${up.bitcoinBlock}` : ''}`)
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
