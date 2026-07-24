#!/usr/bin/env node
/**
 * Salt-oku audit zincir doğrulayıcı.
 * Hash kuralı = src/audit-hash.ts / validateChain (hash+signature hariç JSON → sha256).
 *
 * Usage: node scripts/audit-chain-check.mjs <sink.jsonl>
 * exit 0 temiz · exit 1 kırık/self-hash · exit 2 kullanım
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const GENESIS = '0'.repeat(64)

function computeEntryHash(entry) {
  const signed = { ...entry }
  delete signed.hash
  delete signed.signature
  return createHash('sha256').update(JSON.stringify(signed)).digest('hex')
}

function check(sinkPath) {
  const abs = resolve(sinkPath)
  const result = {
    sink: abs,
    exists: existsSync(abs),
    bytes: 0,
    lines: 0,
    prevHashBreaks: [],
    selfHashMismatches: [],
    ok: true,
  }
  if (!result.exists) {
    result.ok = true
    result.note = 'sink yok — genesis kabul'
    return result
  }
  result.bytes = statSync(abs).size
  const raw = readFileSync(abs, 'utf-8').trim()
  if (!raw) {
    result.note = 'boş sink'
    return result
  }
  const lines = raw.split('\n').filter(Boolean)
  result.lines = lines.length
  let previous = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch (e) {
      result.ok = false
      result.prevHashBreaks.push({
        index: i,
        timestamp: null,
        error: `invalid JSON: ${e.message}`,
      })
      continue
    }
    if (entry.prevHash !== previous) {
      result.ok = false
      result.prevHashBreaks.push({
        index: i,
        timestamp: entry.timestamp || null,
        expectedPrev: previous,
        actualPrev: entry.prevHash || null,
        entryHash: entry.hash || null,
      })
    }
    if (!entry.hash) {
      result.ok = false
      result.selfHashMismatches.push({
        index: i,
        timestamp: entry.timestamp || null,
        error: 'missing hash',
      })
    } else {
      const expected = computeEntryHash(entry)
      if (entry.hash !== expected) {
        result.ok = false
        result.selfHashMismatches.push({
          index: i,
          timestamp: entry.timestamp || null,
          expected,
          actual: entry.hash,
        })
      }
    }
    if (entry.hash) previous = entry.hash
  }
  return result
}

function human(r) {
  const lines = [
    `sink: ${r.sink}`,
    `exists: ${r.exists} · bytes: ${r.bytes} · lines: ${r.lines}`,
    `prevHash breaks: ${r.prevHashBreaks.length}`,
    `self-hash mismatches (tamper şüphesi): ${r.selfHashMismatches.length}`,
    `ok: ${r.ok}`,
  ]
  if (r.prevHashBreaks[0]) {
    const b = r.prevHashBreaks[0]
    lines.push(
      `first break: index=${b.index} ts=${b.timestamp} expectedPrev=${(b.expectedPrev || '').slice(0, 12)}… actualPrev=${(b.actualPrev || '').slice(0, 12)}…`,
    )
  }
  return lines.join('\n')
}

const sink = process.argv[2]
if (!sink) {
  console.error('Usage: node scripts/audit-chain-check.mjs <sink.jsonl>')
  process.exit(2)
}
const r = check(sink)
console.log(JSON.stringify(r, null, 2))
console.error(human(r))
process.exit(r.ok ? 0 : 1)
