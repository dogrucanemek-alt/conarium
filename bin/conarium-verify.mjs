#!/usr/bin/env node
/**
 * conarium-verify — independent offline verifier for Conarium Receipt v0.1.
 *
 * ZERO imports from src/. Canonicalization is duplicated here on purpose:
 * a third party must be able to run this single file without the Conarium package.
 *
 * Usage:
 *   conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...]
 *                   [--anchor-check] [--require-head-anchor] [--expect-seq-from N]
 *                   [--expect-count N] [--expect-last-hash sha256:…] [--strict] [--json]
 *
 * Exit codes (design §5):
 *   0  chain intact, signatures valid
 *  10  hash mismatch (tampered)
 *  11  prevHash break (deleted / inserted) OR opt-in tail pin
 *      (--expect-count / --expect-last-hash) missed; also --strict without a pin
 *  12  seq gap or non-increasing
 *  13  signature invalid / no pubkey
 *  14  claimed anchor proof failed under --anchor-check
 *      (null anchors are skipped; --require-head-anchor fails if head is unanchored)
 *  15  anchor COULD NOT BE CHECKED (calendar unreachable, verifier not installed)
 *      — deliberately distinct from 14: "I could not verify" is not "this is invalid"
 *  20  schema invalid
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, extname } from 'path'

const RECEIPT_V1 = 'conarium-receipt/0.1'
const RECEIPT_V2 = 'conarium-receipt/0.2'
const RECEIPT_V3 = 'conarium-receipt/0.3'
const RECEIPT_V4 = 'conarium-receipt/0.4'
const SURUMLER = [RECEIPT_V1, RECEIPT_V2, RECEIPT_V3, RECEIPT_V4]
// Tek sozluk. v0.3 model/client uc degeri kullanir; v0.4 disclosure `measured`
// ekler. DECLARED/VERIFIED ikinci set yoktur.
const META_KAYNAKLARI = ['protocol', 'measured', 'operator-declared', 'undeclared']
const META_V3 = ['protocol', 'operator-declared', 'undeclared']
const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

// ─── JCS subset (must match src/receipt.ts canonicalize) ─────────────────────

function canonicalize(obj) {
  return canonValue(obj)
}

function canonValue(v) {
  if (v === null) return 'null'
  if (v === undefined) {
    throw new Error('canonicalize: undefined is not allowed (omit the field)')
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number')
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return '[' + v.map(canonValue).join(',') + ']'
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
    const parts = []
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + canonValue(v[k]))
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalize: unsupported type ${typeof v}`)
}

function receiptHash(r) {
  const copy = { ...r }
  delete copy.hash
  delete copy.sig
  delete copy.anchor
  if (copy.chain && typeof copy.chain === 'object') {
    const chain = { ...copy.chain }
    delete chain.hash
    copy.chain = chain
  }
  const digest = createHash('sha256').update(canonicalize(copy)).digest('hex')
  return `sha256:${digest}`
}

// Exported for cross-check tests (dynamic import of this file).
export { canonicalize, receiptHash }

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...] [--anchor-check] [--require-head-anchor] [--anchors <path>] [--expect-seq-from N] [--expect-count N] [--expect-last-hash sha256:…] [--strict] [--json]',
  )
}

function parseArgs(argv) {
  const out = {
    target: null,
    pubkeys: [],
    anchorCheck: false,
    requireHeadAnchor: false,
    anchorsPath: null,
    expectSeqFrom: null,
    expectCount: null,
    expectLastHash: null,
    strict: false,
    json: false,
  }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--pubkey') {
      const p = args.shift()
      if (!p) throw new Error('--pubkey requires a path')
      out.pubkeys.push(p)
    } else if (a === '--anchor-check') {
      out.anchorCheck = true
    } else if (a === '--require-head-anchor') {
      out.requireHeadAnchor = true
      out.anchorCheck = true
    } else if (a === '--anchors') {
      const p = args.shift()
      if (!p) throw new Error('--anchors requires a path')
      out.anchorsPath = p
    } else if (a === '--expect-seq-from') {
      const n = args.shift()
      if (n === undefined || !/^\d+$/.test(n)) throw new Error('--expect-seq-from requires an integer')
      out.expectSeqFrom = Number(n)
    } else if (a === '--expect-count') {
      const n = args.shift()
      if (n === undefined || !/^\d+$/.test(n)) throw new Error('--expect-count requires an integer')
      out.expectCount = Number(n)
    } else if (a === '--expect-last-hash') {
      const h = args.shift()
      if (!h || !/^sha256:[0-9a-fA-F]{64}$/.test(h)) {
        throw new Error('--expect-last-hash requires sha256:<64 hex chars>')
      }
      out.expectLastHash = h.toLowerCase()
    } else if (a === '--strict') {
      out.strict = true
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--help' || a === '-h') {
      usage()
      process.exit(0)
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`)
    } else if (!out.target) {
      out.target = a
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  return out
}

function isTailPinned(opts) {
  return opts.expectCount !== null || opts.expectLastHash !== null || opts.anchorCheck
}

const TAIL_UNPINNED_NOTE =
  'note: tail truncation is not visible — this run did not see receipts deleted from the end of the file. Pin with --expect-count, --expect-last-hash, or --anchor-check.'

function hashPrefixToBuffer(hash) {
  const hex = typeof hash === 'string' && hash.startsWith('sha256:') ? hash.slice(7) : hash
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('anchor hash must be sha256:<64 hex>')
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new Error('anchor hash must decode to 32 bytes')
  return buf
}

function loadAnchorSidecar(path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function findAnchorRecord(rows, ref) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].hash === ref) return rows[i]
  }
  return null
}

async function verifyOtsProof(otsBase64, hash) {
  let client
  try {
    client = await import(new URL('../dist/ots/client.js', import.meta.url))
  } catch {
    // Built-in client lives in dist/. A lone copy of this file cannot check
    // anchors — that is "could not check" (15), not "invalid" (14).
    return { unknown: true, detail: 'ots client not available — anchor not checked' }
  }
  const hashBuf = hashPrefixToBuffer(hash)
  const result = await client.verifyProof(Buffer.from(otsBase64, 'base64'), hashBuf)
  if (result.unknown) {
    return { unknown: true, detail: result.detail || 'anchor calendar unreachable' }
  }
  if (!result.ok) {
    return { ok: false, pending: false, detail: result.detail }
  }
  return { ok: true, pending: result.pending }
}

function loadVerifyKeys(paths) {
  if (paths.length === 0) {
    return { error: 'no --pubkey given (refusing to skip signature checks)', code: 13 }
  }
  const keys = new Map()
  for (const path of paths) {
    if (!existsSync(path)) {
      return { error: `public key not found: ${path}`, code: 13 }
    }
    let pem
    try {
      pem = readFileSync(path, 'utf-8')
    } catch (err) {
      return { error: `cannot read public key ${path}: ${err.message}`, code: 13 }
    }
    let publicKey
    try {
      publicKey = createPublicKey(pem)
    } catch (err) {
      return { error: `invalid public PEM ${path}: ${err.message}`, code: 13 }
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return { error: `expected Ed25519 at ${path}, got ${publicKey.asymmetricKeyType}`, code: 13 }
    }
    const sidecar = `${path}.keyid`
    if (!existsSync(sidecar)) {
      return { error: `missing keyId sidecar: ${sidecar}`, code: 13 }
    }
    const keyId = readFileSync(sidecar, 'utf-8').trim()
    if (!keyId) {
      return { error: `empty keyId sidecar: ${sidecar}`, code: 13 }
    }
    keys.set(keyId, publicKey)
  }
  return { keys }
}

function loadReceipts(target) {
  if (!existsSync(target)) {
    return { error: `path not found: ${target}`, code: 20 }
  }
  const st = statSync(target)
  let files = []
  if (st.isDirectory()) {
    files = readdirSync(target)
      .filter((f) => ['.json', '.jsonl', '.receipt'].includes(extname(f)))
      .map((f) => join(target, f))
      .sort()
  } else {
    files = [target]
  }

  const receipts = []
  for (const file of files) {
    const raw = readFileSync(file, 'utf-8').trim()
    if (!raw) continue
    const lines = raw.includes('\n') && !raw.trimStart().startsWith('[')
      ? raw.split('\n').filter(Boolean)
      : [raw]
    for (let i = 0; i < lines.length; i++) {
      let obj
      try {
        obj = JSON.parse(lines[i])
      } catch (err) {
        return { error: `invalid JSON in ${file}:${i + 1}: ${err.message}`, code: 20 }
      }
      if (Array.isArray(obj)) {
        for (const item of obj) receipts.push({ file, receipt: item })
      } else {
        receipts.push({ file, receipt: obj })
      }
    }
  }
  return { receipts }
}

function schemaOk(r) {
  if (!r || typeof r !== 'object') return 'not an object'
  if (!SURUMLER.includes(r.v)) return `unsupported version ${r.v}`
  if (typeof r.id !== 'string' || !r.id) return 'missing id'
  if (typeof r.ts !== 'string') return 'missing ts'
  if (!r.chain || typeof r.chain !== 'object') return 'missing chain'
  if (!Number.isInteger(r.chain.seq)) return 'chain.seq not integer'
  if (typeof r.chain.prevHash !== 'string') return 'missing chain.prevHash'
  if (typeof r.chain.hash !== 'string') return 'missing chain.hash'
  // Her iki surumde de null olmali; undefined sema kaymasi sayilir -> 20.
  // (Riza baglama gelecek bir surumun isi, v0.2'nin degil.)
  if (r.consentRef !== null && r.consentRef !== undefined) {
    return 'consentRef must be null'
  }
  if (!('consentRef' in r)) return 'missing consentRef (must be null)'
  if (!('anchor' in r)) return 'missing anchor field'
  // Govde alanlari da semaya dahildir. Bunlar olmadan da hash zaten tutmaz ve
  // exit 10 doner — ama "kurcalanmis" TESHISI yanlis olur: eksik alanli bir
  // kayit degistirilmis bir makbuz degil, hic makbuz degildir. Teshis dogru
  // olsun diye burada yakalaniyor (test-vectors/007 bunu kilitliyor).
  for (const alan of ['period', 'request', 'dataRefs', 'policy', 'flags', 'masking', 'outcome']) {
    if (!(alan in r) || r[alan] === null || r[alan] === undefined) return `missing ${alan}`
  }
  if (!Array.isArray(r.dataRefs)) return 'dataRefs must be an array'
  if (!Array.isArray(r.flags)) return 'flags must be an array'
  if (typeof r.policy !== 'object' || typeof r.policy.decision !== 'string') {
    return 'policy.decision is required'
  }
  // v0.1: aktör "service" olmak zorunda (degismedi — eski makbuzlar aynen dogrulanir)
  if (r.v === RECEIPT_V1) {
    if (!r.actor || r.actor.type !== 'service') return 'actor.type must be "service" in v0.1'
  } else {
    if (!r.actor || (r.actor.type !== 'service' && r.actor.type !== 'user')) {
      return 'actor.type must be "service" or "user" in v0.2'
    }
    if (typeof r.actor.assurance !== 'string' || !r.actor.assurance) {
      return 'actor.assurance is required in v0.2'
    }
    if (r.actor.type === 'user' && r.actor.assurance === 'shared-token') {
      return 'actor.type "user" cannot carry assurance "shared-token"'
    }
  }
  // v0.3: model/client artik DEGERI ile birlikte KAYNAGINI da tasir.
  // "undeclared" gecerli bir makbuzdur — eksik degil, durustce bos.
  // v0.4 ayni model/client kurallarini korur; disclosure/destination EKLER.
  // Eski surumlerde bu alanlar zorunlu degil — eksik 0.3 makbuz 20 donmez.
  if (r.v === RECEIPT_V3 || r.v === RECEIPT_V4) {
    for (const alan of ['model', 'client']) {
      const m = r[alan]
      if (!m || typeof m !== 'object') return `missing ${alan}`
      if (!META_V3.includes(m.source)) {
        return `${alan}.source must be one of ${META_V3.join('|')} in ${r.v === RECEIPT_V4 ? 'v0.4' : 'v0.3'}`
      }
      // Bildirilmedi denip deger tasimak celiskidir: makbuz ya bilmiyordur ya bilir.
      if (m.source === 'undeclared') {
        const dolu = alan === 'model'
          ? [m.provider, m.name, m.version].some((x) => x !== null)
          : [m.name, m.version].some((x) => x !== null)
        if (dolu) return `${alan}.source is "undeclared" but carries values`
      }
    }
  }
  if (r.v === RECEIPT_V4) {
    const d = r.disclosure
    if (!d || typeof d !== 'object') return 'missing disclosure'
    if (d.source !== 'measured' && d.source !== 'undeclared') {
      return 'disclosure.source must be measured|undeclared in v0.4'
    }
    if (d.source === 'undeclared') {
      if (!('hash' in d) || !('bytes' in d)) {
        return 'disclosure.hash and disclosure.bytes must be present and null when source is "undeclared"'
      }
      if (d.hash !== null || d.bytes !== null) return 'disclosure.source is "undeclared" but carries values'
    } else {
      if (typeof d.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d.hash)) {
        return 'disclosure.hash must be sha256:<64 hex> when measured'
      }
      if (!Number.isInteger(d.bytes) || d.bytes < 0) return 'disclosure.bytes must be a non-negative integer when measured'
    }
    const dest = r.destination
    if (!dest || typeof dest !== 'object') return 'missing destination'
    if (dest.source !== 'operator-declared' && dest.source !== 'undeclared') {
      return 'destination.source must be operator-declared|undeclared in v0.4'
    }
    if (dest.source === 'undeclared') {
      if (!('value' in dest)) {
        return 'destination.value must be present and null when source is "undeclared"'
      }
      if (dest.value !== null) return 'destination.source is "undeclared" but carries a value'
    } else if (typeof dest.value !== 'string' || dest.value.length === 0) {
      return 'destination.value is required when operator-declared'
    }
  }
  return null
}

function decodeCanonicalBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  const buf = Buffer.from(s, 'base64')
  if (buf.toString('base64') !== s) return null
  return buf
}

function verifySig(keys, receipt) {
  if (!receipt.sig || typeof receipt.sig !== 'object') {
    return 'missing sig'
  }
  if (receipt.sig.alg !== 'Ed25519') return `unsupported sig.alg ${receipt.sig.alg}`
  const pk = keys.get(receipt.sig.keyId)
  if (!pk) return `unknown keyId ${receipt.sig.keyId}`
  const sigBuf = decodeCanonicalBase64(receipt.sig.value)
  if (!sigBuf) return 'signature is not canonical base64'
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(receipt.chain.hash, 'utf-8'),
      pk,
      sigBuf,
    )
    return ok ? null : 'signature cryptographically invalid'
  } catch (err) {
    return `signature verify error: ${err.message}`
  }
}

function fail(code, message, jsonMode, extra = {}) {
  const payload = { ok: false, code, message, ...extra }
  console.error(message)
  if (jsonMode) console.log(JSON.stringify(payload))
  process.exit(code)
}

async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    usage(err.message)
    process.exit(20)
  }
  if (!opts.target) {
    usage('missing <file|dir>')
    process.exit(20)
  }

  if (opts.strict && opts.expectSeqFrom === null) {
    opts.expectSeqFrom = 1
  }
  if (opts.strict && !isTailPinned(opts)) {
    fail(
      11,
      'strict mode requires a tail pin: --expect-count, --expect-last-hash, or --anchor-check',
      opts.json,
    )
  }

  const keyResult = loadVerifyKeys(opts.pubkeys)
  if (keyResult.error) {
    fail(keyResult.code, keyResult.error, opts.json)
  }
  const { keys } = keyResult

  const loaded = loadReceipts(opts.target)
  if (loaded.error) {
    fail(loaded.code, loaded.error, opts.json)
  }
  const { receipts } = loaded

  let anchorRows = []
  if (opts.anchorCheck) {
    const defaultAnchors =
      opts.anchorsPath ||
      (existsSync(opts.target) && statSync(opts.target).isFile()
        ? `${opts.target}.anchors.jsonl`
        : null)
    if (defaultAnchors && existsSync(defaultAnchors)) {
      anchorRows = loadAnchorSidecar(defaultAnchors)
    }
  }

  if (receipts.length === 0) {
    if (opts.expectCount !== null) {
      fail(
        11,
        `count mismatch: expected ${opts.expectCount} receipt(s), found 0`,
        opts.json,
        { expected: opts.expectCount, found: 0 },
      )
    }
    if (opts.expectLastHash !== null) {
      fail(
        11,
        `last-hash mismatch: expected ${opts.expectLastHash}, found (empty chain)`,
        opts.json,
        { expected: opts.expectLastHash, found: null },
      )
    }
    console.error(
      'warning: empty chain (0 receipts) — this is not a verification that nothing was deleted. A hash chain cannot see a tail that is no longer in the file. Pass --expect-count or --expect-last-hash to pin length.',
    )
    if (opts.requireHeadAnchor) {
      fail(14, 'head anchor required but chain is empty', opts.json, { count: 0 })
    }
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        code: 0,
        warning: 'empty',
        count: 0,
        tailPinned: isTailPinned(opts),
      }))
    }
    process.exit(0)
  }
  if (receipts.length === 1) {
    console.error('warning: single-receipt chain')
  }

  let prevHash = GENESIS
  let prevSeq = opts.expectSeqFrom !== null ? opts.expectSeqFrom - 1 : null
  let pendingAnchorWarned = false
  let anchoredCount = 0
  let headAnchored = false

  for (let i = 0; i < receipts.length; i++) {
    const { file, receipt } = receipts[i]
    const where = `${file}#${i}`

    const schemaErr = schemaOk(receipt)
    if (schemaErr) {
      fail(20, `schema invalid at ${where}: ${schemaErr}`, opts.json, { index: i, file })
    }

    const expected = receiptHash(receipt)
    if (receipt.chain.hash !== expected) {
      fail(10, `hash mismatch at ${where}: recomputed ${expected}, stored ${receipt.chain.hash}`, opts.json, {
        index: i,
        file,
      })
    }

    if (receipt.chain.prevHash !== prevHash) {
      fail(
        11,
        `prevHash break at ${where}: expected ${prevHash}, got ${receipt.chain.prevHash}`,
        opts.json,
        { index: i, file },
      )
    }

    if (prevSeq !== null) {
      if (receipt.chain.seq !== prevSeq + 1) {
        fail(
          12,
          `seq gap at ${where}: expected ${prevSeq + 1}, got ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
    } else if (i > 0) {
      // After first receipt, seq must increase by exactly 1
      // (first receipt establishes the baseline)
    }
    if (i > 0) {
      const prev = receipts[i - 1].receipt
      if (receipt.chain.seq <= prev.chain.seq) {
        fail(
          12,
          `seq non-increasing at ${where}: ${prev.chain.seq} → ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
      if (receipt.chain.seq !== prev.chain.seq + 1) {
        fail(
          12,
          `seq gap at ${where}: expected ${prev.chain.seq + 1}, got ${receipt.chain.seq}`,
          opts.json,
          { index: i, file },
        )
      }
    }
    if (opts.expectSeqFrom !== null && i === 0 && receipt.chain.seq !== opts.expectSeqFrom) {
      fail(
        12,
        `seq start mismatch at ${where}: expected ${opts.expectSeqFrom}, got ${receipt.chain.seq}`,
        opts.json,
        { index: i, file },
      )
    }

    const sigErr = verifySig(keys, receipt)
    if (sigErr) {
      fail(13, `signature invalid at ${where}: ${sigErr}`, opts.json, { index: i, file })
    }

    if (opts.anchorCheck) {
      if (receipt.anchor === null || receipt.anchor === undefined) {
        // Periodic anchoring leaves most receipts null — skip, do not fail.
      } else {
        if (typeof receipt.anchor !== 'object' || typeof receipt.anchor.log !== 'string') {
          fail(14, `anchor proof invalid at ${where}`, opts.json, { index: i, file })
        }
        const ref = receipt.anchor.ref || receipt.chain.hash
        const row = findAnchorRecord(anchorRows, ref)
        if (!row) {
          fail(14, `anchor sidecar record missing for ref ${ref} at ${where}`, opts.json, {
            index: i,
            file,
          })
        }
        if (!row.ots) {
          fail(14, `anchor ots missing in sidecar for ref ${ref} at ${where}`, opts.json, {
            index: i,
            file,
          })
        }
        const otsResult = await verifyOtsProof(row.ots, receipt.chain.hash)
        // 15 ÖNCE gelir: "kontrol edemedim" ile "kanıt tutmuyor" farklı cevaplardır
        // ve ikincisi birincisini yutarsa doğrulayıcı bilmediği bir şeyi iddia eder.
        // Sessizce 0 dönmek de aynı ölçüde yanlış olurdu — çağıran, çıpanın
        // doğrulanmadığını BİLMELİ, sadece doğrulanamadığını.
        if (otsResult.unknown) {
          fail(
            15,
            `anchor could not be checked at ${where}: ${otsResult.detail}`,
            opts.json,
            { index: i, file },
          )
        }
        if (!otsResult.ok) {
          fail(
            14,
            `anchor proof failed at ${where}: ${otsResult.detail || 'verify failed'}`,
            opts.json,
            { index: i, file },
          )
        }
        anchoredCount += 1
        if (i === receipts.length - 1) headAnchored = true
        if (otsResult.pending || row.state === 'pending') {
          if (!pendingAnchorWarned) {
            console.error(
              'warning: anchor pending (calendar only, not yet Bitcoin-attested)',
            )
            pendingAnchorWarned = true
          }
        }
      }
    }

    prevHash = receipt.chain.hash
    prevSeq = receipt.chain.seq
  }

  if (opts.expectCount !== null && receipts.length !== opts.expectCount) {
    fail(
      11,
      `count mismatch: expected ${opts.expectCount} receipt(s), found ${receipts.length}`,
      opts.json,
      { expected: opts.expectCount, found: receipts.length },
    )
  }
  if (opts.expectLastHash !== null) {
    const lastHash = receipts[receipts.length - 1].receipt.chain.hash
    if (String(lastHash).toLowerCase() !== opts.expectLastHash) {
      fail(
        11,
        `last-hash mismatch: expected ${opts.expectLastHash}, got ${lastHash}`,
        opts.json,
        { expected: opts.expectLastHash, found: lastHash },
      )
    }
  }

  // Bildirilmemis meta BASARISIZLIK DEGILDIR — ama sessizce de gecmez. Denetci
  // "N makbuz dogrulandi" cumlesini okurken, kacinin model kimligi tasimadigini
  // gormeli; aksi halde dogrulama, olcmedigi bir seyi onaylamis gibi okunur.
  // NOT: receipts elemanlari {file, receipt} sarmalidir — dogrudan r.model okumak
  // sessizce hep 0 verir (bu tam olarak bir kez yasandi, e2e kosusu yakaladi).
  const modelBildirilmemis = receipts.filter((r) => r.receipt?.model?.source === 'undeclared').length
  const clientBildirilmemis = receipts.filter((r) => r.receipt?.client?.source === 'undeclared').length
  const notlar = []
  if (modelBildirilmemis) notlar.push(`${modelBildirilmemis} with undeclared model`)
  if (clientBildirilmemis) notlar.push(`${clientBildirilmemis} with undeclared client`)

  if (opts.requireHeadAnchor && !headAnchored) {
    fail(14, 'head anchor required but head is not anchored', opts.json, {
      anchored: anchoredCount,
      total: receipts.length,
      headAnchored: false,
    })
  }

  const summary = `${anchoredCount}/${receipts.length} anchored, head anchored: ${headAnchored ? 'yes' : 'no'}`
  const tailPinned = isTailPinned(opts)
  if (!tailPinned) console.error(TAIL_UNPINNED_NOTE)

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      code: 0,
      count: receipts.length,
      undeclaredModel: modelBildirilmemis,
      undeclaredClient: clientBildirilmemis,
      anchored: anchoredCount,
      headAnchored,
      anchorSummary: opts.anchorCheck ? summary : undefined,
      tailPinned,
    }))
  } else {
    const ek = notlar.length ? ` (${notlar.join(', ')})` : ''
    console.log(`ok: ${receipts.length} receipt(s) verified${ek}`)
    if (opts.anchorCheck) console.log(summary)
  }
  process.exit(0)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('conarium-verify.mjs') ||
    process.argv[1].endsWith('conarium-verify'))

if (isDirect) {
  main().catch((err) => {
    console.error(err)
    process.exit(20)
  })
}
