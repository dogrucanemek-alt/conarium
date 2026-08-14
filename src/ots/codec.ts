/** Binary reader/writer for the OpenTimestamps proof format. Node builtins only. */

export class OtsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OtsError'
  }
}

export class Reader {
  constructor(
    private readonly buf: Buffer,
    private offset = 0,
  ) {}

  remaining(): number {
    return this.buf.length - this.offset
  }

  eof(): boolean {
    return this.offset >= this.buf.length
  }

  readByte(): number {
    if (this.offset >= this.buf.length) throw new OtsError('truncated OTS proof')
    return this.buf[this.offset++]
  }

  read(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new OtsError('truncated OTS proof')
    const slice = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return Buffer.from(slice)
  }

  readVaruint(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const b = this.readByte()
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value
      shift += 7
      if (shift > 35) throw new OtsError('varuint too long')
    }
  }

  readVarbytes(max = 4096): Buffer {
    const n = this.readVaruint()
    if (n > max) throw new OtsError(`varbytes length ${n} exceeds ${max}`)
    return this.read(n)
  }

  assertMagic(magic: Buffer): void {
    const got = this.read(magic.length)
    if (!got.equals(magic)) throw new OtsError('not an OpenTimestamps proof (bad magic)')
  }

  assertEof(): void {
    if (!this.eof()) throw new OtsError('trailing garbage after OTS proof')
  }
}

export class Writer {
  private chunks: Buffer[] = []

  writeByte(b: number): void {
    this.chunks.push(Buffer.from([b & 0xff]))
  }

  write(buf: Buffer | number[]): void {
    this.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
  }

  writeVaruint(value: number): void {
    if (value < 0 || !Number.isFinite(value)) throw new OtsError('invalid varuint')
    if (value === 0) {
      this.writeByte(0)
      return
    }
    let v = value >>> 0
    while (v > 0x7f) {
      this.writeByte((v & 0x7f) | 0x80)
      v >>>= 7
    }
    this.writeByte(v)
  }

  writeVarbytes(buf: Buffer): void {
    this.writeVaruint(buf.length)
    this.write(buf)
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}
