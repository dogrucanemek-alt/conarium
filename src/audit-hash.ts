import { createHash } from 'crypto'

/** validateChain / log() ile aynı kural: hash+signature hariç JSON → sha256. */
export function computeEntryHash(entry: Record<string, unknown>): string {
  const signed: Record<string, unknown> = { ...entry }
  delete signed.hash
  delete signed.signature
  return createHash('sha256').update(JSON.stringify(signed)).digest('hex')
}

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
