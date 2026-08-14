/** OpenTimestamps calendar HTTP. fetch only — no `request` / web3. */
import { OtsError, Reader } from './codec.js'
import { deserializeTimestamp, type Timestamp } from './format.js'

export const DEFAULT_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
]

const HEADERS = {
  Accept: 'application/vnd.opentimestamps.v1',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'conarium-ots',
}

const ALLOWED_HOST_SUFFIXES = [
  '.calendar.opentimestamps.org',
  '.pool.opentimestamps.org',
  '.calendar.eternitywall.com',
  '.calendar.catallaxy.com',
  'ots.btc.catallaxy.com',
]

export function calendarAllowed(uri: string): boolean {
  let host: string
  try {
    host = new URL(uri).hostname.toLowerCase()
  } catch {
    return false
  }
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))
}

async function calendarFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Buffer> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, headers: { ...HEADERS, ...(init.headers || {}) } })
    if (res.status === 404) throw new OtsError(`calendar 404: ${url}`)
    if (!res.ok) throw new OtsError(`calendar HTTP ${res.status}: ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 10_000) throw new OtsError('calendar response exceeded 10KB')
    return buf
  } catch (err) {
    if (err instanceof OtsError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new OtsError(`calendar unreachable: ${msg}`)
  } finally {
    clearTimeout(t)
  }
}

export async function submitDigest(calendarUrl: string, digest: Buffer, timeoutMs = 15_000): Promise<Timestamp> {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`
  const body = await calendarFetch(
    new URL('digest', base).href,
    { method: 'POST', body: new Uint8Array(digest) },
    timeoutMs,
  )
  return deserializeTimestamp(new Reader(body), digest)
}

export async function fetchUpgraded(
  calendarUrl: string,
  commitment: Buffer,
  timeoutMs = 15_000,
): Promise<Timestamp> {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`
  const url = new URL(`timestamp/${commitment.toString('hex')}`, base).href
  const body = await calendarFetch(url, { method: 'GET' }, timeoutMs)
  return deserializeTimestamp(new Reader(body), commitment)
}

export type EsploraBlock = { merkleroot: string; time: number }

export async function fetchBitcoinBlock(height: number, timeoutMs = 15_000): Promise<EsploraBlock> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const hashRes = await fetch(`https://blockstream.info/api/block-height/${height}`, { signal: ac.signal })
    if (!hashRes.ok) throw new OtsError(`esplora block-height HTTP ${hashRes.status}`)
    const hash = (await hashRes.text()).trim()
    const blockRes = await fetch(`https://blockstream.info/api/block/${hash}`, { signal: ac.signal })
    if (!blockRes.ok) throw new OtsError(`esplora block HTTP ${blockRes.status}`)
    const json = (await blockRes.json()) as { merkle_root?: string; timestamp?: number }
    if (!json.merkle_root || json.timestamp == null) throw new OtsError('esplora block missing merkle_root')
    return { merkleroot: json.merkle_root, time: json.timestamp }
  } catch (err) {
    if (err instanceof OtsError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new OtsError(`esplora unreachable: ${msg}`)
  } finally {
    clearTimeout(t)
  }
}
