/**
 * Fuzz the receipt JSONL parser + hash path.
 * Invalid input must not crash the process; hash/schema throws are swallowed.
 */
import { canonicalize, receiptHash } from '../dist/receipt.js'

export function fuzz(data) {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  const lines = raw.includes('\n') && !raw.trimStart().startsWith('[')
    ? raw.split('\n')
    : [raw]
  for (const line of lines) {
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (Array.isArray(obj)) {
      for (const item of obj) hashOne(item)
    } else {
      hashOne(obj)
    }
  }
}

function hashOne(obj) {
  if (!obj || typeof obj !== 'object') return
  try {
    canonicalize(obj)
    receiptHash(obj)
  } catch {
    // unsupported type / missing shape — not a crash
  }
}
