#!/usr/bin/env node
/**
 * Read the document information dictionary a PDF reader would actually show.
 *
 * The first version of this check scanned the whole file for `/Title` and
 * accepted any match. An adversarial review broke it in one move: append an
 * object carrying the right title, leave the real dictionary empty, and the
 * check went green while `pdfinfo` still reported nothing. A byte that no
 * cross-reference table points at is not the document's metadata — it is
 * litter, and litter must not be able to vouch for an artefact.
 *
 * So this module does what a reader does. It starts at the last `startxref`,
 * walks the cross-reference chain back through every incremental update,
 * takes `/Info` from the newest trailer that names one, and resolves that one
 * object — whether it sits in the file directly or inside a compressed object
 * stream. Anything the chain does not reach is never read.
 *
 * Run directly to execute its own fixtures:
 *   node test/pdf_info_dict.mjs
 */
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { deflateSync } from 'node:zlib'

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

class Ref {
  constructor(num, gen) {
    this.num = num
    this.gen = gen
  }
}

class Stream {
  constructor(dict, raw) {
    this.dict = dict
    this.raw = raw
  }
}

class Name {
  constructor(name) {
    this.name = name
  }
}

/** A PDF string carries bytes, not characters; decoding happens at the end. */
class PdfString {
  constructor(bytes) {
    this.bytes = bytes
  }
}

function isWhite(byte) {
  return WHITESPACE.has(byte)
}

function isRegular(byte) {
  return byte !== undefined && !WHITESPACE.has(byte) && !DELIMITER.has(byte)
}

class Lexer {
  constructor(buf, pos = 0) {
    this.buf = buf
    this.pos = pos
  }

  skipSpace() {
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos]
      if (isWhite(byte)) {
        this.pos += 1
      } else if (byte === 0x25) {
        // a comment runs to the end of the line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) {
          this.pos += 1
        }
      } else {
        return
      }
    }
  }

  /** The next regular-character run, e.g. `obj`, `endobj`, `12`, `R`. */
  peekToken() {
    const save = this.pos
    this.skipSpace()
    let end = this.pos
    while (isRegular(this.buf[end])) end += 1
    const token = this.buf.toString('latin1', this.pos, end)
    this.pos = save
    return token
  }

  readToken() {
    this.skipSpace()
    const start = this.pos
    while (isRegular(this.buf[this.pos])) this.pos += 1
    if (this.pos === start) {
      this.pos += 1
      return this.buf.toString('latin1', start, this.pos)
    }
    return this.buf.toString('latin1', start, this.pos)
  }

  readName() {
    this.pos += 1 // the leading slash
    const bytes = []
    while (isRegular(this.buf[this.pos])) {
      let byte = this.buf[this.pos]
      if (byte === 0x23 && this.pos + 2 < this.buf.length) {
        const hex = this.buf.toString('latin1', this.pos + 1, this.pos + 3)
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          byte = parseInt(hex, 16)
          this.pos += 2
        }
      }
      bytes.push(byte)
      this.pos += 1
    }
    return new Name(Buffer.from(bytes).toString('latin1'))
  }

  readLiteralString() {
    this.pos += 1 // the opening parenthesis
    const bytes = []
    let depth = 1
    const shorthand = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c }
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos]
      if (byte === 0x5c) {
        // an escape sequence
        const next = String.fromCharCode(this.buf[this.pos + 1])
        this.pos += 2
        if (next >= '0' && next <= '7') {
          let octal = next
          while (
            octal.length < 3 &&
            this.buf[this.pos] >= 0x30 &&
            this.buf[this.pos] <= 0x37
          ) {
            octal += String.fromCharCode(this.buf[this.pos])
            this.pos += 1
          }
          bytes.push(parseInt(octal, 8) & 0xff)
        } else if (shorthand[next] !== undefined) {
          bytes.push(shorthand[next])
        } else if (next === '\n') {
          // a line continuation contributes nothing
        } else if (next === '\r') {
          if (this.buf[this.pos] === 0x0a) this.pos += 1
        } else {
          bytes.push(next.charCodeAt(0) & 0xff)
        }
        continue
      }
      if (byte === 0x28) {
        // A balanced inner parenthesis is part of the string, not its end.
        depth += 1
        bytes.push(byte)
        this.pos += 1
        continue
      }
      if (byte === 0x29) {
        depth -= 1
        this.pos += 1
        if (depth === 0) return new PdfString(Buffer.from(bytes))
        bytes.push(byte)
        continue
      }
      bytes.push(byte)
      this.pos += 1
    }
    throw new Error('unterminated literal string')
  }

  readHexString() {
    this.pos += 1 // the opening angle bracket
    let hex = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(this.buf[this.pos])
      if (/[0-9A-Fa-f]/.test(ch)) hex += ch
      this.pos += 1
    }
    this.pos += 1 // the closing angle bracket
    if (hex.length % 2 === 1) hex += '0'
    return new PdfString(Buffer.from(hex, 'hex'))
  }

  readObject() {
    this.skipSpace()
    const byte = this.buf[this.pos]
    if (byte === undefined) throw new Error('unexpected end of file')
    if (byte === 0x2f) return this.readName()
    if (byte === 0x28) return this.readLiteralString()
    if (byte === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.readDictOrStream()
      return this.readHexString()
    }
    if (byte === 0x5b) {
      this.pos += 1
      const items = []
      for (;;) {
        this.skipSpace()
        if (this.buf[this.pos] === 0x5d) {
          this.pos += 1
          return items
        }
        if (this.pos >= this.buf.length) throw new Error('unterminated array')
        items.push(this.readObject())
      }
    }
    const token = this.readToken()
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^[+-]?[\d.]+$/.test(token)) {
      // `12 0 R` is a reference; `12 0 obj` is a header; a bare number is a number.
      const save = this.pos
      const second = this.peekToken()
      if (/^\d+$/.test(token) && /^\d+$/.test(second)) {
        this.readToken()
        const third = this.peekToken()
        if (third === 'R') {
          this.readToken()
          return new Ref(Number(token), Number(second))
        }
        this.pos = save
      }
      return Number(token)
    }
    throw new Error(`unreadable token ${JSON.stringify(token)} at ${this.pos}`)
  }

  readDictOrStream() {
    this.pos += 2 // <<
    const dict = new Map()
    for (;;) {
      this.skipSpace()
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      if (this.pos >= this.buf.length) throw new Error('unterminated dictionary')
      const key = this.readName()
      const value = this.readObject()
      // A repeated key is malformed. Keep the first and remember the clash so
      // a caller can refuse the file rather than pick a winner silently.
      if (dict.has(key.name)) dict.set('__duplicate__', key.name)
      else dict.set(key.name, value)
    }
    const save = this.pos
    this.skipSpace()
    if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6
      if (this.buf[this.pos] === 0x0d) this.pos += 1
      if (this.buf[this.pos] === 0x0a) this.pos += 1
      const length = dict.get('Length')
      if (typeof length !== 'number') {
        throw new Error('stream length must be a direct integer in the files this reads')
      }
      const raw = this.buf.subarray(this.pos, this.pos + length)
      this.pos += length
      return new Stream(dict, raw)
    }
    this.pos = save
    return dict
  }
}

/** Undo a PNG row predictor, the only kind cross-reference streams use. */
function unpredict(data, predictor, columns, colors, bits) {
  if (predictor < 10) return data
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8))
  const rowLength = columns * bpp
  const rows = []
  let previous = Buffer.alloc(rowLength)
  for (let at = 0; at + 1 + rowLength <= data.length + rowLength; at += rowLength + 1) {
    if (at >= data.length) break
    const filter = data[at]
    const row = Buffer.from(data.subarray(at + 1, at + 1 + rowLength))
    if (row.length < rowLength) break
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0
      const up = previous[i]
      const upLeft = i >= bpp ? previous[i - bpp] : 0
      switch (filter) {
        case 0: break
        case 1: row[i] = (row[i] + left) & 0xff; break
        case 2: row[i] = (row[i] + up) & 0xff; break
        case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const nearest = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          row[i] = (row[i] + nearest) & 0xff
          break
        }
        default: throw new Error(`unsupported PNG predictor filter ${filter}`)
      }
    }
    rows.push(row)
    previous = row
  }
  return Buffer.concat(rows)
}

function decodeStream(stream) {
  const filter = stream.dict.get('Filter')
  const names = filter instanceof Name ? [filter] : Array.isArray(filter) ? filter : []
  let data = Buffer.from(stream.raw)
  for (const entry of names) {
    if (!(entry instanceof Name)) throw new Error('filter entries must be names')
    if (entry.name === 'FlateDecode') data = inflateSync(data)
    else throw new Error(`unsupported stream filter ${entry.name}`)
  }
  const parms = stream.dict.get('DecodeParms')
  if (parms instanceof Map) {
    const predictor = parms.get('Predictor') ?? 1
    data = unpredict(
      data,
      predictor,
      parms.get('Columns') ?? 1,
      parms.get('Colors') ?? 1,
      parms.get('BitsPerComponent') ?? 8,
    )
  }
  return data
}

function lastStartXref(buf) {
  const tail = buf.toString('latin1', Math.max(0, buf.length - 4096))
  const at = tail.lastIndexOf('startxref')
  assert.ok(at !== -1, 'no startxref: this is not a PDF this check can read')
  const match = tail.slice(at + 'startxref'.length).match(/\s*(\d+)/)
  assert.ok(match, 'startxref is not followed by an offset')
  return Number(match[1])
}

/**
 * Walk the cross-reference chain from newest to oldest. Returns the merged
 * entry table (newest wins) and the trailer dictionaries in that order.
 */
function readXrefChain(buf) {
  const entries = new Map()
  const trailers = []
  const visited = new Set()
  let offset = lastStartXref(buf)
  while (offset !== undefined && offset !== null) {
    assert.ok(
      !visited.has(offset),
      `cross-reference chain loops back to offset ${offset}`,
    )
    visited.add(offset)
    assert.ok(offset >= 0 && offset < buf.length, `cross-reference offset ${offset} is outside the file`)
    const lexer = new Lexer(buf, offset)
    let trailer
    if (lexer.peekToken() === 'xref') {
      lexer.readToken()
      // classic table: repeated `start count` headers, then 20-byte entries
      for (;;) {
        lexer.skipSpace()
        if (lexer.peekToken() === 'trailer') {
          lexer.readToken()
          trailer = lexer.readObject()
          break
        }
        const start = Number(lexer.readToken())
        const count = Number(lexer.readToken())
        assert.ok(Number.isInteger(start) && Number.isInteger(count), 'malformed xref subsection header')
        for (let i = 0; i < count; i += 1) {
          lexer.skipSpace()
          const at = Number(lexer.readToken())
          const gen = Number(lexer.readToken())
          const kind = lexer.readToken()
          const num = start + i
          if (kind === 'n' && !entries.has(num)) entries.set(num, { type: 1, offset: at, gen })
          if (kind === 'f' && !entries.has(num)) entries.set(num, { type: 0 })
        }
      }
    } else {
      // cross-reference stream: `N G obj << /Type /XRef ... >> stream`
      lexer.readToken() // object number
      lexer.readToken() // generation
      const keyword = lexer.readToken()
      assert.equal(keyword, 'obj', `expected an object at cross-reference offset ${offset}`)
      const stream = lexer.readObject()
      assert.ok(stream instanceof Stream, 'cross-reference offset does not point at a stream')
      const type = stream.dict.get('Type')
      assert.ok(type instanceof Name && type.name === 'XRef', 'cross-reference stream is not /Type /XRef')
      const widths = stream.dict.get('W')
      assert.ok(Array.isArray(widths) && widths.length >= 3, '/W must list three field widths')
      const data = decodeStream(stream)
      const size = stream.dict.get('Size')
      const index = stream.dict.get('Index') ?? [0, size]
      const [w0, w1, w2] = widths.map(Number)
      const width = w0 + w1 + w2
      let at = 0
      for (let section = 0; section < index.length; section += 2) {
        const start = Number(index[section])
        const count = Number(index[section + 1])
        for (let i = 0; i < count; i += 1) {
          if (at + width > data.length) break
          const read = (from, length) => {
            let value = 0
            for (let b = 0; b < length; b += 1) value = value * 256 + data[from + b]
            return value
          }
          const kind = w0 === 0 ? 1 : read(at, w0)
          const second = read(at + w0, w1)
          const third = read(at + w0 + w1, w2)
          at += width
          const num = start + i
          if (entries.has(num)) continue
          if (kind === 1) entries.set(num, { type: 1, offset: second, gen: third })
          else if (kind === 2) entries.set(num, { type: 2, container: second, index: third })
          else entries.set(num, { type: 0 })
        }
      }
      trailer = stream.dict
    }
    assert.ok(trailer instanceof Map, 'cross-reference section has no trailer dictionary')
    trailers.push(trailer)
    const prev = trailer.get('Prev')
    offset = typeof prev === 'number' ? prev : undefined
  }
  return { entries, trailers }
}

function objectAt(buf, offset, expectedNum) {
  const lexer = new Lexer(buf, offset)
  const num = Number(lexer.readToken())
  lexer.readToken() // generation
  const keyword = lexer.readToken()
  assert.equal(keyword, 'obj', `offset ${offset} does not begin an object`)
  assert.equal(num, expectedNum, `offset ${offset} holds object ${num}, not ${expectedNum}`)
  return lexer.readObject()
}

function resolve(buf, entries, ref) {
  if (!(ref instanceof Ref)) return ref
  const entry = entries.get(ref.num)
  assert.ok(entry, `object ${ref.num} is not in any cross-reference section`)
  assert.notEqual(entry.type, 0, `object ${ref.num} is marked free`)
  if (entry.type === 1) return objectAt(buf, entry.offset, ref.num)
  // type 2: the object lives inside a compressed object stream
  const container = resolve(buf, entries, new Ref(entry.container, 0))
  assert.ok(container instanceof Stream, `object stream ${entry.container} is not a stream`)
  const data = decodeStream(container)
  const count = Number(container.dict.get('N'))
  const first = Number(container.dict.get('First'))
  const header = new Lexer(data, 0)
  const offsets = []
  for (let i = 0; i < count; i += 1) {
    offsets.push({ num: Number(header.readToken()), at: Number(header.readToken()) })
  }
  const slot = offsets[entry.index]
  assert.ok(slot, `object stream ${entry.container} has no slot ${entry.index}`)
  assert.equal(slot.num, ref.num, `object stream slot ${entry.index} holds ${slot.num}, not ${ref.num}`)
  return new Lexer(data, first + slot.at).readObject()
}

/** UTF-16BE when the string opens with a byte order mark, PDFDocEncoding otherwise. */
export function decodeTextString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    assert.equal(
      (bytes.length - 2) % 2,
      0,
      'a UTF-16BE text string with an odd byte count is malformed',
    )
    return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  }
  return bytes.toString('latin1')
}

/**
 * The document information dictionary the newest trailer points at, as plain
 * strings. Returns null when the file has no /Info at all.
 */
export function readInfoDict(buf) {
  const { entries, trailers } = readXrefChain(buf)
  let infoRef
  for (const trailer of trailers) {
    if (trailer.has('__duplicate__')) {
      throw new Error(`trailer repeats the key /${trailer.get('__duplicate__')}`)
    }
    if (trailer.has('Info')) {
      infoRef = trailer.get('Info')
      break
    }
  }
  if (infoRef === undefined) return null
  const info = resolve(buf, entries, infoRef)
  assert.ok(info instanceof Map, '/Info does not resolve to a dictionary')
  if (info.has('__duplicate__')) {
    throw new Error(`the information dictionary repeats the key /${info.get('__duplicate__')}`)
  }
  const out = {}
  for (const [key, value] of info) {
    if (value instanceof PdfString) out[key] = decodeTextString(value.bytes)
    else if (value instanceof Name) out[key] = `/${value.name}`
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Fixtures. Run this file directly to execute them.
// ---------------------------------------------------------------------------

/** Assemble a minimal but structurally valid PDF with a classic xref table. */
function buildPdf({ title, author, infoBody, extraObjects = '', decoy = null }) {
  const info = infoBody ?? `/Title (${title}) /Author (${author})`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
    `4 0 obj\n<< ${info} >>\nendobj\n`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(body.length)
    body += object
  }
  // Litter: an object no cross-reference entry points at.
  if (decoy) body += `9 0 obj\n<< /Title (${decoy.title}) /Author (${decoy.author}) >>\nendobj\n`
  body += extraObjects
  const startxref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function runFixtures() {
  // 1 — the ordinary case
  const plain = readInfoDict(buildPdf({ title: 'Hello', author: 'Ada' }))
  assert.equal(plain.Title, 'Hello')
  assert.equal(plain.Author, 'Ada')

  // 2 — the attack that broke the first version of this check: an unreferenced
  // object carrying the right answer while the real dictionary is empty.
  const littered = readInfoDict(
    buildPdf({ title: '', author: '', decoy: { title: 'Hello', author: 'Ada' } }),
  )
  assert.equal(littered.Title, '', 'an unreferenced object must not be read as metadata')
  assert.equal(littered.Author, '')

  // 3 — balanced parentheses belong to the string
  const nested = readInfoDict(buildPdf({ title: 'Alpha (nested) Omega', author: 'Ada' }))
  assert.equal(nested.Title, 'Alpha (nested) Omega')

  // 4 — escapes, including an escaped closing parenthesis
  const escaped = readInfoDict(buildPdf({ title: 'a\\)b\\\\c', author: 'Ada' }))
  assert.equal(escaped.Title, 'a)b\\c')

  // 5 — UTF-16BE, the encoding hyperref writes under the unicode option
  const utf16 = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from('Doğru', 'utf16le').swap16(),
  ])
  assert.equal(decodeTextString(utf16), 'Doğru')
  assert.throws(
    () => decodeTextString(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00])])),
    /odd byte count/,
    'a truncated UTF-16BE string must be refused, not half-read',
  )

  // 6 — an incremental update supersedes the original dictionary
  const base = buildPdf({ title: 'Old', author: 'Ada' })
  const appended = Buffer.from(
    `10 0 obj\n<< /Title (New) /Author (Ada) >>\nendobj\n`,
    'latin1',
  )
  const updateOffset = base.length
  const xrefOffset = base.length + appended.length
  const update = Buffer.concat([
    base,
    appended,
    Buffer.from(
      `xref\n0 1\n0000000000 65535 f \n10 1\n${String(updateOffset).padStart(10, '0')} 00000 n \n` +
        `trailer\n<< /Size 11 /Root 1 0 R /Info 10 0 R /Prev ${lastStartXref(base)} >>\n` +
        `startxref\n${xrefOffset}\n%%EOF\n`,
      'latin1',
    ),
  ])
  assert.equal(
    readInfoDict(update).Title,
    'New',
    'the newest trailer decides which /Info is current',
  )

  // 7 — a compressed object stream, the shape pdfTeX actually produces
  const inner = '4 0 << /Title (Streamed) /Author (Ada) >>'
  const innerOffsets = '4 0 '
  const objStmPayload = Buffer.from(innerOffsets + inner.slice('4 0 '.length), 'latin1')
  const first = innerOffsets.length
  const packed = deflateSync(objStmPayload)
  let doc = '%PDF-1.5\n'
  const catalogAt = doc.length
  doc += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const pagesAt = doc.length
  doc += '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
  const stmAt = doc.length
  const head = Buffer.from(
    `5 0 obj\n<< /Type /ObjStm /N 1 /First ${first} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const prefix = Buffer.from(doc, 'latin1')
  const xrefAt = prefix.length + head.length + packed.length + tail.length
  const widths = [1, 4, 2]
  const rows = [
    [0, 0, 65535],
    [1, catalogAt, 0],
    [1, pagesAt, 0],
    [0, 0, 0],
    [2, 5, 0],
    [1, stmAt, 0],
  ]
  const table = Buffer.concat(
    rows.map(([kind, second, third]) => {
      const row = Buffer.alloc(widths[0] + widths[1] + widths[2])
      row.writeUInt8(kind, 0)
      row.writeUInt32BE(second, 1)
      row.writeUInt16BE(third, 5)
      return row
    }),
  )
  const tablePacked = deflateSync(table)
  const xrefObject = Buffer.from(
    `6 0 obj\n<< /Type /XRef /Size 7 /Index [0 6] /W [1 4 2] /Root 1 0 R /Info 4 0 R ` +
      `/Length ${tablePacked.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  )
  const compressed = Buffer.concat([
    prefix,
    head,
    packed,
    tail,
    xrefObject,
    tablePacked,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'),
  ])
  assert.equal(
    readInfoDict(compressed).Title,
    'Streamed',
    'an /Info inside a compressed object stream must be read',
  )

  // 8 — a repeated key is malformed, not a coin flip
  assert.throws(
    () => readInfoDict(buildPdf({ infoBody: '/Title (One) /Title (Two) /Author (Ada)' })),
    /repeats the key/,
    'a duplicated /Title must be refused',
  )

  // 9 — a cross-reference chain that points at itself must stop, not spin
  const looping = buildPdf({ title: 'Loop', author: 'Ada' })
  const selfReferential = Buffer.from(
    looping
      .toString('latin1')
      .replace(/trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info 4 0 R >>/, (_, size) =>
        `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R /Prev ${lastStartXref(looping)} >>`),
    'latin1',
  )
  assert.throws(
    () => readInfoDict(selfReferential),
    /loops back to offset/,
    'a self-referential /Prev must be refused rather than followed forever',
  )

  console.log('pdf info dict GREEN 9 fixtures (litter, nesting, escapes, utf-16, update, objstm, duplicate, loop)')
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('pdf_info_dict.mjs')) {
  runFixtures()
}
