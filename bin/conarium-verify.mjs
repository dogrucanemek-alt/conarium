#!/usr/bin/env node
/**
 * conarium-verify — independent offline verifier for Conarium Receipt v0.1.
 *
 * ZERO imports from src/. Canonicalization is duplicated here on purpose:
 * a third party must be able to run this single file without the Conarium package.
 *
 * Usage:
 *   conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...]
 *                   [--anchor-check] [--expect-seq-from N]
 *                   [--expect-count N] [--expect-last-hash sha256:…] [--json]
 *
 * Exit codes (design §5):
 *   0  chain intact, signatures valid
 *  10  hash mismatch (tampered)
 *  11  prevHash break (deleted / inserted) OR opt-in tail pin
 *      (--expect-count / --expect-last-hash) missed
 *  12  seq gap or non-increasing
 *  13  signature invalid / no pubkey
 *  14  anchor proof failed / missing under --anchor-check
 *  15  anchor COULD NOT BE CHECKED (calendar unreachable, verifier not installed)
 *      — deliberately distinct from 14: "I could not verify" is not "this is invalid"
 *  20  schema invalid
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, extname } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const RECEIPT_V1 = 'conarium-receipt/0.1'
const RECEIPT_V2 = 'conarium-receipt/0.2'
const RECEIPT_V3 = 'conarium-receipt/0.3'
const SURUMLER = [RECEIPT_V1, RECEIPT_V2, RECEIPT_V3]
// v0.3 meta kaynaklari. Bilinmeyen bir kaynak sema hatasidir: "protocol" yazip
// olcmemis olmak, dogrulayanin makbuza fazladan guvenmesi demek olurdu.
const META_KAYNAKLARI = ['protocol', 'operator-declared', 'undeclared']
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
    'Usage: conarium-verify <file|dir> --pubkey <path> [--pubkey <path2> ...] [--anchor-check] [--anchors <path>] [--expect-seq-from N] [--expect-count N] [--expect-last-hash sha256:…] [--json]',
  )
}

function parseArgs(argv) {
  const out = {
    target: null,
    pubkeys: [],
    anchorCheck: false,
    anchorsPath: null,
    expectSeqFrom: null,
    expectCount: null,
    expectLastHash: null,
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

/**
 * "Kontrol edemedim" ile "kanıt geçersiz" ayrımı.
 *
 * Yalnızca KESİN ulaşılamama durumları buraya girer. Tanımadığımız bir hata
 * `unknown` sayılmaz, 14 (kanıt başarısız) tarafında kalır: belirsizliği
 * "sorun yok" yönüne yuvarlamak, bu ayrımı yapmanın amacını yok ederdi.
 */
const AG_HATA_KODLARI = new Set([
  'ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE',
])
const AG_HATA_DESENI = /socket hang up|socket timed? ?out|network (is )?unreachable|getaddrinfo|request-promise|ESOCKETTIMEDOUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i

function ulasilamadiMi(err) {
  if (!err) return false
  if (err.code && AG_HATA_KODLARI.has(String(err.code))) return true
  if (err.cause && err.cause.code && AG_HATA_KODLARI.has(String(err.cause.code))) return true
  return AG_HATA_DESENI.test(String(err.message || err))
}

async function verifyOtsProof(otsBase64, hash) {
  let OpenTimestamps
  try {
    OpenTimestamps = require('javascript-opentimestamps')
    if (OpenTimestamps && OpenTimestamps.default) OpenTimestamps = OpenTimestamps.default
  } catch {
    // "Kontrol edemedim", "kanıt geçersiz" DEĞİL. Paket 2026-08-12'den beri
    // opsiyonel bir bağımlılık (bagimlilik agacindaki kritik aciklar nedeniyle),
    // dolayısıyla bu durum artık istisna değil, sıradan bir kurulum hâli.
    return { unknown: true, detail: 'javascript-opentimestamps not installed — anchor not checked' }
  }
  try {
    const hashBuf = hashPrefixToBuffer(hash)
    const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      hashBuf,
    )
    const detachedOts = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(otsBase64, 'base64'))
    // Digest mismatch (proof for another hash) → fail closed before calendar I/O when possible
    if (typeof detachedOts.fileDigest === 'function') {
      const fileDigest = Buffer.from(detachedOts.fileDigest())
      if (!fileDigest.equals(hashBuf)) {
        return { ok: false, pending: false, detail: 'ots proof digest does not match chain hash' }
      }
    }
    const verified = await OpenTimestamps.verify(detachedOts, detached, {
      ignoreBitcoinNode: true,
      timeout: 15000,
    })
    if (!verified || Object.keys(verified).length === 0) {
      return { ok: true, pending: true }
    }
    return { ok: true, pending: !verified.bitcoin }
  } catch (err) {
    // Takvime/blok gezginine ulaşılamaması bir KANIT BAŞARISIZLIĞI değildir.
    // Bu projenin bütün iddiası "kaydedilmedi ≠ olmadı" ayrımını yapmak; kendi
    // doğrulayıcısı içeride bu ayrımı yapmazsa iddia kendi kodunda çürür.
    // Dijest karşılaştırması zaten yukarıda ÇEVRİMDIŞI yapıldı, yani yerel
    // gerçek kaybolmuyor — kaybolan yalnızca zaman kanıtının teyidi.
    if (ulasilamadiMi(err)) {
      return { unknown: true, detail: `anchor calendar unreachable: ${err.message || String(err)}` }
    }
    return { ok: false, pending: false, detail: err.message || String(err) }
  }
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
  if (r.v === RECEIPT_V3) {
    for (const alan of ['model', 'client']) {
      const m = r[alan]
      if (!m || typeof m !== 'object') return `missing ${alan}`
      if (!META_KAYNAKLARI.includes(m.source)) {
        return `${alan}.source must be one of ${META_KAYNAKLARI.join('|')} in v0.3`
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
  return null
}

function verifySig(keys, receipt) {
  if (!receipt.sig || typeof receipt.sig !== 'object') {
    return 'missing sig'
  }
  if (receipt.sig.alg !== 'Ed25519') return `unsupported sig.alg ${receipt.sig.alg}`
  const pk = keys.get(receipt.sig.keyId)
  if (!pk) return `unknown keyId ${receipt.sig.keyId}`
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(receipt.chain.hash, 'utf-8'),
      pk,
      Buffer.from(receipt.sig.value, 'base64'),
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
    if (opts.json) console.log(JSON.stringify({ ok: true, code: 0, warning: 'empty', count: 0 }))
    process.exit(0)
  }
  if (receipts.length === 1) {
    console.error('warning: single-receipt chain')
  }

  let prevHash = GENESIS
  let prevSeq = opts.expectSeqFrom !== null ? opts.expectSeqFrom - 1 : null
  let pendingAnchorWarned = false

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
        fail(14, `anchor missing at ${where} (--anchor-check)`, opts.json, { index: i, file })
      }
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
      if (otsResult.pending || row.state === 'pending') {
        if (!pendingAnchorWarned) {
          console.error(
            'warning: anchor pending (calendar only, not yet Bitcoin-attested)',
          )
          pendingAnchorWarned = true
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

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      code: 0,
      count: receipts.length,
      undeclaredModel: modelBildirilmemis,
      undeclaredClient: clientBildirilmemis,
    }))
  } else {
    const ek = notlar.length ? ` (${notlar.join(', ')})` : ''
    console.log(`ok: ${receipts.length} receipt(s) verified${ek}`)
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
