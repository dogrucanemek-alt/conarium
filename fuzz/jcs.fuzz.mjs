/**
 * Fuzz the JCS subset canonicalizer.
 * JSON.parse output is the RFC 8785 subset we claim; canonicalize must either
 * return a string or refuse with its own documented error.
 *
 * A refusal is not a crash. `2e999` parses to Infinity, which RFC 8785 cannot
 * represent, so canonicalize throws `canonicalize: non-finite number` on
 * purpose. Only errors it raises about itself are expected here: anything else
 * — a TypeError, a RangeError from recursion depth — is a real finding and
 * must still fail the run.
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
  try {
    canonicalize(value)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('canonicalize:')) return
    throw err
  }
}
