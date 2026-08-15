/**
 * Fuzz the JCS subset canonicalizer.
 * JSON.parse output is the RFC 8785 subset we claim; canonicalize must not crash on it.
 */
import { canonicalize } from '../dist/receipt.js'

export function fuzz(data) {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return
  }
  canonicalize(value)
}
