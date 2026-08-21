import { createHash } from 'crypto'

/** Same rule as validateChain / log(): JSON excluding hash+signature+sig+anchor → sha256. */
export function computeEntryHash(entry: Record<string, unknown>): string {
  const signed: Record<string, unknown> = { ...entry }
  delete signed.hash
  delete signed.signature
  delete signed.sig
  delete signed.anchor
  return createHash('sha256').update(JSON.stringify(signed)).digest('hex')
}

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
