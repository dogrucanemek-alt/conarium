/**
 * Load the operator's receipt sink for the console. No invented receipts.
 */
import { createPublicKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import {
  type Receipt,
  type ReceiptChainCheck,
  verifyReceiptChain,
} from './receipt.js'
import { parseTrustPubkeyPaths } from './keys.js'

export const EMPTY_RECEIPTS_MESSAGE =
  'henüz makbuz yok. Gateway `audit.receiptSink` ile çalışıyorsa her erişim bir satır yazar.'

export const NO_SINK_MESSAGE =
  'henüz makbuz yok. `conarium.config.json` içinde `audit.receiptSink` yok; denetim kaydı makbuz değildir.'

export interface ReceiptListItem {
  id: string
  ts: string
  actor: string
  tool: string
  decision: string
  maskedCount: number
  seq: number
}

export interface LoadedReceipts {
  sink: string | null
  receipts: Receipt[]
  chain: ReceiptChainCheck
  emptyMessage: string | null
}

export function resolveReceiptSink(configFile: string): string | null {
  try {
    if (!existsSync(configFile)) return null
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as {
      audit?: { receiptSink?: unknown }
    }
    const sink = raw?.audit?.receiptSink
    if (typeof sink !== 'string' || !sink.trim()) return null
    return isAbsolute(sink) ? sink : resolve(dirname(configFile), sink)
  } catch {
    return null
  }
}

export function readReceiptJsonl(file: string): { receipts: Receipt[]; parseBreak?: number } {
  if (!existsSync(file)) return { receipts: [] }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const receipts: Receipt[] = []
  let seen = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    seen += 1
    try {
      receipts.push(JSON.parse(line) as Receipt)
    } catch {
      return { receipts, parseBreak: seen }
    }
  }
  return { receipts }
}

export function loadReceiptsForConsole(configFile: string): LoadedReceipts {
  const sink = resolveReceiptSink(configFile)
  if (!sink) {
    return {
      sink: null,
      receipts: [],
      chain: { ok: true, entries: 0 },
      emptyMessage: NO_SINK_MESSAGE,
    }
  }
  if (!existsSync(sink)) {
    return {
      sink,
      receipts: [],
      chain: { ok: true, entries: 0 },
      emptyMessage: EMPTY_RECEIPTS_MESSAGE,
    }
  }
  const { receipts, parseBreak } = readReceiptJsonl(sink)
  if (parseBreak != null) {
    return {
      sink,
      receipts,
      chain: { ok: false, brokenAt: parseBreak, reason: 'unreadable', entries: receipts.length },
      emptyMessage: receipts.length === 0 ? EMPTY_RECEIPTS_MESSAGE : null,
    }
  }
  const chain = verifyReceiptChain(receipts)
  return {
    sink,
    receipts,
    chain,
    emptyMessage: receipts.length === 0 ? EMPTY_RECEIPTS_MESSAGE : null,
  }
}

export function toListItems(receipts: Receipt[]): ReceiptListItem[] {
  return receipts
    .map((r) => ({
      id: String(r.id || ''),
      ts: String(r.ts || ''),
      actor: r.actor?.id || 'unknown',
      tool: r.request?.tool || '',
      decision: r.policy?.decision || '',
      maskedCount: Number(r.masking?.maskedCount || 0),
      seq: Number(r.chain?.seq || 0),
    }))
    .reverse()
}

export function findReceipt(receipts: Receipt[], id: string): Receipt | null {
  return receipts.find((r) => r.id === id) ?? null
}

/** Public PEM only. Never returns a private key block. */
export function publicPemForPanel(): string | null {
  for (const p of parseTrustPubkeyPaths()) {
    if (!existsSync(p)) continue
    const pem = readFileSync(p, 'utf8')
    if (/BEGIN PRIVATE KEY|BEGIN.*PRIVATE/.test(pem)) continue
    if (/BEGIN PUBLIC KEY/.test(pem)) return pem
  }
  const priv = process.env.CONARIUM_AUDIT_SIGNING_KEY?.trim()
  if (!priv) return null
  const candidates = [priv.replace(/\.pem$/i, '.pub.pem'), `${priv}.pub.pem`]
  for (const c of candidates) {
    if (c === priv || !existsSync(c)) continue
    const pem = readFileSync(c, 'utf8')
    if (/BEGIN PRIVATE KEY|BEGIN.*PRIVATE/.test(pem)) continue
    if (/BEGIN PUBLIC KEY/.test(pem)) return pem
  }
  if (!existsSync(priv)) return null
  try {
    const raw = readFileSync(priv, 'utf8')
    const pub = createPublicKey(raw).export({ type: 'spki', format: 'pem' }).toString()
    if (/BEGIN PRIVATE KEY|BEGIN.*PRIVATE/.test(pub)) return null
    return pub
  } catch {
    return null
  }
}

export function verifyCommandFor(sink: string | null): string {
  const file = sink ? basename(sink) : 'conarium-receipts.jsonl'
  return `npx conarium-verify ${file} --pubkey <key.pub.pem>`
}
