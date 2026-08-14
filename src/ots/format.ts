/**
 * OpenTimestamps detached-proof format (read/write).
 * Hashing uses Node `crypto`. This is the published OTS binary layout, not a new scheme.
 */
import { createHash, randomBytes } from 'node:crypto'
import { OtsError, Reader, Writer } from './codec.js'

export const HEADER_MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])
const MAJOR_VERSION = 1
const TAG_ATTESTATION = 0x00
const TAG_SEPARATOR = 0xff

const PENDING_TAG = Buffer.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e])
const BITCOIN_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01])

export type Op =
  | { kind: 'sha256' }
  | { kind: 'sha1' }
  | { kind: 'ripemd160' }
  | { kind: 'append'; arg: Buffer }
  | { kind: 'prepend'; arg: Buffer }
  | { kind: 'reverse' }

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: Buffer; payload: Buffer }

export type Timestamp = {
  msg: Buffer
  attestations: Attestation[]
  ops: { op: Op; next: Timestamp }[]
}

export type DetachedProof = {
  hashOp: 'sha256'
  fileHash: Buffer
  timestamp: Timestamp
}

export function applyOp(op: Op, msg: Buffer): Buffer {
  switch (op.kind) {
    case 'sha256':
      return createHash('sha256').update(msg).digest()
    case 'sha1':
      return createHash('sha1').update(msg).digest()
    case 'ripemd160':
      return createHash('ripemd160').update(msg).digest()
    case 'append':
      return Buffer.concat([msg, op.arg])
    case 'prepend':
      return Buffer.concat([op.arg, msg])
    case 'reverse':
      return Buffer.from(msg).reverse()
  }
}

function readOp(reader: Reader, tag: number): Op {
  if (tag === 0x08) return { kind: 'sha256' }
  if (tag === 0x02) return { kind: 'sha1' }
  if (tag === 0x03) return { kind: 'ripemd160' }
  if (tag === 0xf0) return { kind: 'append', arg: reader.readVarbytes() }
  if (tag === 0xf1) return { kind: 'prepend', arg: reader.readVarbytes() }
  if (tag === 0xf2) return { kind: 'reverse' }
  throw new OtsError(`unsupported OTS operation tag 0x${tag.toString(16)}`)
}

function writeOp(writer: Writer, op: Op): void {
  switch (op.kind) {
    case 'sha256':
      writer.writeByte(0x08)
      return
    case 'sha1':
      writer.writeByte(0x02)
      return
    case 'ripemd160':
      writer.writeByte(0x03)
      return
    case 'append':
      writer.writeByte(0xf0)
      writer.writeVarbytes(op.arg)
      return
    case 'prepend':
      writer.writeByte(0xf1)
      writer.writeVarbytes(op.arg)
      return
    case 'reverse':
      writer.writeByte(0xf2)
      return
  }
}

function readAttestation(reader: Reader): Attestation {
  const tag = reader.read(8)
  const payload = reader.readVarbytes(8192)
  const inner = new Reader(payload)
  if (tag.equals(PENDING_TAG)) {
    const uriBytes = inner.readVarbytes(1000)
    return { kind: 'pending', uri: uriBytes.toString('ascii') }
  }
  if (tag.equals(BITCOIN_TAG)) {
    return { kind: 'bitcoin', height: inner.readVaruint() }
  }
  return { kind: 'unknown', tag, payload }
}

function writeAttestation(writer: Writer, att: Attestation): void {
  const payload = new Writer()
  let tag: Buffer
  if (att.kind === 'pending') {
    tag = PENDING_TAG
    payload.writeVarbytes(Buffer.from(att.uri, 'ascii'))
  } else if (att.kind === 'bitcoin') {
    tag = BITCOIN_TAG
    payload.writeVaruint(att.height)
  } else {
    tag = att.tag
    payload.write(att.payload)
  }
  writer.write(tag)
  writer.writeVarbytes(payload.toBuffer())
}

export function deserializeTimestamp(reader: Reader, initialMsg: Buffer): Timestamp {
  const self: Timestamp = { msg: Buffer.from(initialMsg), attestations: [], ops: [] }

  const take = (tag: number) => {
    if (tag === TAG_ATTESTATION) {
      self.attestations.push(readAttestation(reader))
      return
    }
    const op = readOp(reader, tag)
    const nextMsg = applyOp(op, self.msg)
    self.ops.push({ op, next: deserializeTimestamp(reader, nextMsg) })
  }

  let tag = reader.readByte()
  while (tag === TAG_SEPARATOR) {
    take(reader.readByte())
    tag = reader.readByte()
  }
  take(tag)
  return self
}

function attestationOrder(a: Attestation, b: Attestation): number {
  const rank = (x: Attestation) => (x.kind === 'bitcoin' ? 0 : x.kind === 'pending' ? 1 : 2)
  const d = rank(a) - rank(b)
  if (d !== 0) return d
  if (a.kind === 'pending' && b.kind === 'pending') return a.uri.localeCompare(b.uri)
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height - b.height
  return 0
}

export function serializeTimestamp(writer: Writer, ts: Timestamp): void {
  const atts = [...ts.attestations].sort(attestationOrder)
  const ops = ts.ops
  if (atts.length === 0 && ops.length === 0) throw new OtsError('empty timestamp cannot be serialized')

  if (ops.length === 0) {
    for (let i = 0; i < atts.length - 1; i++) {
      writer.writeByte(TAG_SEPARATOR)
      writer.writeByte(TAG_ATTESTATION)
      writeAttestation(writer, atts[i])
    }
    writer.writeByte(TAG_ATTESTATION)
    writeAttestation(writer, atts[atts.length - 1])
    return
  }

  if (atts.length > 0) {
    for (const att of atts) {
      writer.writeByte(TAG_SEPARATOR)
      writer.writeByte(TAG_ATTESTATION)
      writeAttestation(writer, att)
    }
  }
  for (let i = 0; i < ops.length; i++) {
    if (i < ops.length - 1) writer.writeByte(TAG_SEPARATOR)
    writeOp(writer, ops[i].op)
    serializeTimestamp(writer, ops[i].next)
  }
}

export function deserializeDetached(bytes: Buffer): DetachedProof {
  const reader = new Reader(bytes)
  reader.assertMagic(HEADER_MAGIC)
  const major = reader.readVaruint()
  if (major !== MAJOR_VERSION) throw new OtsError(`unsupported OTS major version ${major}`)
  const hashTag = reader.readByte()
  if (hashTag !== 0x08) throw new OtsError('only SHA-256 detached proofs are supported')
  const fileHash = reader.read(32)
  const timestamp = deserializeTimestamp(reader, fileHash)
  reader.assertEof()
  return { hashOp: 'sha256', fileHash, timestamp }
}

export function serializeDetached(proof: DetachedProof): Buffer {
  const writer = new Writer()
  writer.write(HEADER_MAGIC)
  writer.writeVaruint(MAJOR_VERSION)
  writer.writeByte(0x08)
  writer.write(proof.fileHash)
  serializeTimestamp(writer, proof.timestamp)
  return writer.toBuffer()
}

export function fileDigest(proof: DetachedProof): Buffer {
  return proof.fileHash
}

export function collectAttestations(ts: Timestamp): { msg: Buffer; attestation: Attestation }[] {
  const out: { msg: Buffer; attestation: Attestation }[] = []
  for (const attestation of ts.attestations) out.push({ msg: ts.msg, attestation })
  for (const { next } of ts.ops) out.push(...collectAttestations(next))
  return out
}

export function mergeTimestamp(into: Timestamp, other: Timestamp): void {
  if (!into.msg.equals(other.msg)) throw new OtsError('cannot merge timestamps for different messages')
  into.attestations.push(...other.attestations)
  for (const branch of other.ops) {
    const existing = into.ops.find((b) => opsEqual(b.op, branch.op))
    if (existing) mergeTimestamp(existing.next, branch.next)
    else into.ops.push({ op: branch.op, next: branch.next })
  }
}

function opsEqual(a: Op, b: Op): boolean {
  if (a.kind !== b.kind) return false
  if ((a.kind === 'append' || a.kind === 'prepend') && (b.kind === 'append' || b.kind === 'prepend')) {
    return a.arg.equals(b.arg)
  }
  return true
}

/** Single-file stamp tree: fileHash —append(nonce16)→ —sha256→ tip (calendar attestations land on tip). */
export function stampSkeleton(fileHash: Buffer, nonce = randomBytes(16)): { proof: DetachedProof; tip: Timestamp } {
  const appended = applyOp({ kind: 'append', arg: nonce }, fileHash)
  const tipMsg = applyOp({ kind: 'sha256' }, appended)
  const tip: Timestamp = { msg: tipMsg, attestations: [], ops: [] }
  const mid: Timestamp = { msg: appended, attestations: [], ops: [{ op: { kind: 'sha256' }, next: tip }] }
  const root: Timestamp = { msg: fileHash, attestations: [], ops: [{ op: { kind: 'append', arg: nonce }, next: mid }] }
  return { proof: { hashOp: 'sha256', fileHash, timestamp: root }, tip }
}

export function nodesWithAttestations(ts: Timestamp): Timestamp[] {
  if (ts.attestations.length > 0) return [ts]
  return ts.ops.flatMap((b) => nodesWithAttestations(b.next))
}

export function hasBitcoinAttestation(ts: Timestamp): boolean {
  return collectAttestations(ts).some((x) => x.attestation.kind === 'bitcoin')
}
