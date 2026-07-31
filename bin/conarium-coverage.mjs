#!/usr/bin/env node
/**
 * conarium-coverage — independent offline verifier for Conarium Coverage Declaration v0.1.
 *
 * ZERO imports from src/. Canonicalization is duplicated here on purpose:
 * a third party must be able to run this single file without the Conarium package.
 *
 * Usage:
 *   conarium-coverage <declaration.json> --pubkey <path>
 *                     [--receipts <receipts.jsonl>] [--json]
 *
 * Exit codes (design §6):
 *   0  declaration signature valid (+ consistent with receipts if given), chain contiguous
 *  12  chain has gaps (receipts missing) — use --allow-gaps to verify authenticity only
 *  13  signature invalid / no pubkey / unknown keyId
 *  20  schema invalid
 *  30  inconsistent with receipts (count/seq/coverage mismatch)
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import { readFileSync, existsSync } from 'fs'

// v0.1 geriye uyum: eski beyanlar hâlâ doğrulanabilir (kanıtı çöpe atmamak için).
// v0.2, coverage.unassignedReceiptCount alanını ekler. Hangi sürüm olduğu çıktıda belirtilir.
const COVERAGE_V = 'conarium-coverage/0.2'
const COVERAGE_V_LEGACY = 'conarium-coverage/0.1'

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

function coverageHash(d) {
  const copy = { ...d }
  delete copy.sig
  const digest = createHash('sha256').update(canonicalize(copy)).digest('hex')
  return `sha256:${digest}`
}

// Exported for cross-check tests (dynamic import of this file).
export { canonicalize, coverageHash }

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(msg)
  console.error(
    'Usage: conarium-coverage <declaration.json> --pubkey <path> [--receipts <receipts.jsonl>] [--allow-gaps] [--json]',
  )
}

function parseArgs(argv) {
  const out = { target: null, pubkeys: [], receiptsPath: null, json: false, allowGaps: false }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--pubkey') {
      const p = args.shift()
      if (!p) throw new Error('--pubkey requires a path')
      out.pubkeys.push(p)
    } else if (a === '--receipts') {
      const p = args.shift()
      if (!p) throw new Error('--receipts requires a path')
      out.receiptsPath = p
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--allow-gaps') {
      out.allowGaps = true
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

function loadDeclaration(path) {
  if (!existsSync(path)) {
    return { error: `declaration not found: ${path}`, code: 20 }
  }
  let obj
  try {
    obj = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { error: `invalid JSON in declaration: ${err.message}`, code: 20 }
  }
  return { declaration: obj }
}

function loadReceipts(path) {
  if (!existsSync(path)) {
    return { error: `receipts file not found: ${path}`, code: 20 }
  }
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return { receipts: [] }
  const receipts = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { receipts }
}

function schemaOk(d) {
  if (!d || typeof d !== 'object') return 'not an object'
  if (d.v !== COVERAGE_V && d.v !== COVERAGE_V_LEGACY) return `unsupported version ${d.v}`
  if (typeof d.id !== 'string' || !d.id) return 'missing id'
  if (typeof d.ts !== 'string') return 'missing ts'
  if (!d.period || typeof d.period !== 'object') return 'missing period'
  if (typeof d.period.start !== 'string' || typeof d.period.end !== 'string') {
    return 'period.start/end must be strings'
  }
  if (!Array.isArray(d.declaredScope) || d.declaredScope.length === 0) {
    return 'declaredScope must be a non-empty array'
  }
  if (!d.chain || typeof d.chain !== 'object') return 'missing chain'
  if (!Number.isInteger(d.chain.firstSeq)) return 'chain.firstSeq not integer'
  if (!Number.isInteger(d.chain.lastSeq)) return 'chain.lastSeq not integer'
  if (!Number.isInteger(d.chain.count)) return 'chain.count not integer'
  if (typeof d.chain.contiguous !== 'boolean') return 'chain.contiguous not boolean'
  if (!Array.isArray(d.chain.gaps)) return 'chain.gaps must be an array'
  if (!d.decisions || typeof d.decisions !== 'object') return 'missing decisions'
  for (const k of ['allow', 'partial', 'deny']) {
    if (!Number.isInteger(d.decisions[k])) return `decisions.${k} not integer`
  }
  if (!d.coverage || typeof d.coverage !== 'object') return 'missing coverage'
  if (!Number.isInteger(d.coverage.declared)) return 'coverage.declared not integer'
  if (!Number.isInteger(d.coverage.accessed)) return 'coverage.accessed not integer'
  if (!Number.isInteger(d.coverage.notRecorded)) return 'coverage.notRecorded not integer'
  if (!Array.isArray(d.coverage.accessedObjects)) return 'coverage.accessedObjects must be an array'
  if (!Array.isArray(d.coverage.notRecordedObjects)) return 'coverage.notRecordedObjects must be an array'
  // v0.2: unassignedReceiptCount zorunlu. v0.1'de alan yoktu — geriye uyum için yoksa 0 varsay.
  if (d.v === COVERAGE_V && !Number.isInteger(d.coverage.unassignedReceiptCount)) {
    return 'coverage.unassignedReceiptCount not integer'
  }
  if (!d.sig || typeof d.sig !== 'object') return 'missing sig'
  if (d.sig.alg !== 'Ed25519') return `unsupported sig.alg ${d.sig.alg}`
  if (typeof d.sig.keyId !== 'string' || !d.sig.keyId) return 'missing sig.keyId'
  if (typeof d.sig.value !== 'string' || !d.sig.value) return 'missing sig.value'
  return null
}

function verifySig(keys, d) {
  const pk = keys.get(d.sig.keyId)
  if (!pk) return `unknown keyId ${d.sig.keyId}`
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(coverageHash(d), 'utf-8'),
      pk,
      Buffer.from(d.sig.value, 'base64'),
    )
    return ok ? null : 'signature cryptographically invalid'
  } catch (err) {
    return `signature verify error: ${err.message}`
  }
}

/**
 * Beyanı makbuzlarla çapraz kontrol et. Tutarsızlık → hata metni döner, tutarlıysa null.
 * Dürüstlük kuralı: coverage.notRecordedObjects "erişim KAYDEDİLMEDİ" anlamına gelir,
 * "erişilmedi" değil — bu metinlerde de korunur.
 */
function crossCheck(d, receipts) {
  if (receipts.length === 0) {
    return 'declaration claims coverage over receipts but --receipts file is empty'
  }
  // count
  if (receipts.length !== d.chain.count) {
    return `count mismatch: declaration says ${d.chain.count}, receipts file has ${receipts.length}`
  }
  // seq aralığı + kesintisizlik
  const seqs = receipts.map((r) => r.chain.seq).sort((a, b) => a - b)
  if (seqs[0] !== d.chain.firstSeq) {
    return `firstSeq mismatch: declaration says ${d.chain.firstSeq}, receipts start at ${seqs[0]}`
  }
  if (seqs[seqs.length - 1] !== d.chain.lastSeq) {
    return `lastSeq mismatch: declaration says ${d.chain.lastSeq}, receipts end at ${seqs[seqs.length - 1]}`
  }
  const gaps = []
  for (let expected = seqs[0]; expected < seqs[seqs.length - 1]; expected++) {
    if (!seqs.includes(expected)) {
      let found = expected + 1
      while (found <= seqs[seqs.length - 1] && !seqs.includes(found)) found++
      gaps.push({ expectedSeq: expected, foundSeq: found })
    }
  }
  const contiguous = gaps.length === 0
  if (contiguous !== d.chain.contiguous) {
    return `contiguous mismatch: declaration says ${d.chain.contiguous}, receipts are ${contiguous}`
  }
  if (gaps.length !== d.chain.gaps.length) {
    return `gap count mismatch: declaration says ${d.chain.gaps.length}, receipts have ${gaps.length}`
  }
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i].expectedSeq !== d.chain.gaps[i].expectedSeq || gaps[i].foundSeq !== d.chain.gaps[i].foundSeq) {
      return `gap mismatch at index ${i}: declaration ${JSON.stringify(d.chain.gaps[i])}, receipts ${JSON.stringify(gaps[i])}`
    }
  }
  // decisions
  const dec = { allow: 0, partial: 0, deny: 0 }
  for (const r of receipts) {
    if (r.policy.decision === 'allow') dec.allow++
    else if (r.policy.decision === 'partial') dec.partial++
    else if (r.policy.decision === 'deny') dec.deny++
  }
  for (const k of ['allow', 'partial', 'deny']) {
    if (dec[k] !== d.decisions[k]) {
      return `decisions.${k} mismatch: declaration says ${d.decisions[k]}, receipts have ${dec[k]}`
    }
  }
  // coverage — aynı mantık src/coverage.ts computeCoverage ile birebir:
  // nesne kaynağı dataRefs[].object + describe_table'da request.target (ikinci kanıt).
  // list_tables veri erişimi değil (sema listeleme) — nesne sayılmaz.
  const recorded = new Set()
  let unassignedReceiptCount = 0
  for (const r of receipts) {
    let hasObject = false
    for (const ref of r.dataRefs || []) {
      recorded.add(ref.object)
      hasObject = true
    }
    if (r.request?.tool === 'describe_table' && r.request?.target) {
      recorded.add(r.request.target)
      hasObject = true
    }
    if (!hasObject && (r.request?.tool === 'query' || r.request?.tool === 'search')) {
      unassignedReceiptCount++
    }
  }
  const accessedObjects = d.declaredScope.filter((o) => recorded.has(o))
  const notRecordedObjects = d.declaredScope.filter((o) => !recorded.has(o))
  if (accessedObjects.length !== d.coverage.accessed) {
    return `coverage.accessed mismatch: declaration says ${d.coverage.accessed}, receipts show ${accessedObjects.length}`
  }
  if (notRecordedObjects.length !== d.coverage.notRecorded) {
    return `coverage.notRecorded mismatch: declaration says ${d.coverage.notRecorded}, receipts show ${notRecordedObjects.length}`
  }
  // v0.2: belirsizlik sayacı makbuzlardan hesaplanıp beyanla karşılaştırılır.
  // v0.1'de alan yoktu — geriye uyum için atla.
  if (d.v === COVERAGE_V && unassignedReceiptCount !== d.coverage.unassignedReceiptCount) {
    return `coverage.unassignedReceiptCount mismatch: declaration says ${d.coverage.unassignedReceiptCount}, receipts show ${unassignedReceiptCount}`
  }
  for (const o of d.coverage.accessedObjects) {
    if (!accessedObjects.includes(o)) {
      return `coverage.accessedObjects contains "${o}" but receipts show no recorded access to it`
    }
  }
  for (const o of d.coverage.notRecordedObjects) {
    if (!notRecordedObjects.includes(o)) {
      return `coverage.notRecordedObjects contains "${o}" but receipts show recorded access to it`
    }
  }
  return null
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
    usage('missing <declaration.json>')
    process.exit(20)
  }

  const keyResult = loadVerifyKeys(opts.pubkeys)
  if (keyResult.error) {
    fail(keyResult.code, keyResult.error, opts.json)
  }
  const { keys } = keyResult

  const declResult = loadDeclaration(opts.target)
  if (declResult.error) {
    fail(declResult.code, declResult.error, opts.json)
  }
  const d = declResult.declaration

  const schemaErr = schemaOk(d)
  if (schemaErr) {
    fail(20, `schema invalid: ${schemaErr}`, opts.json)
  }

  const expected = coverageHash(d)
  // coverageHash strips sig; recompute over the body and compare against stored hash
  // is not stored in the declaration (hash is implicit in sig). We verify sig directly.
  const sigErr = verifySig(keys, d)
  if (sigErr) {
    fail(13, `signature invalid: ${sigErr}`, opts.json)
  }

  if (opts.receiptsPath) {
    const recResult = loadReceipts(opts.receiptsPath)
    if (recResult.error) {
      fail(recResult.code, recResult.error, opts.json)
    }
    const crossErr = crossCheck(d, recResult.receipts)
    if (crossErr) {
      fail(30, `inconsistent with receipts: ${crossErr}`, opts.json)
    }
  }

  // Zincir kesintisizliği: CI'da sorulan soru "kapsamam eksiksiz mi?" (b).
  // Zincirde boşluk = makbuz EKSİK = kapsam eksik. Varsayılan SIKI: boşluk varsa
  // "ok:" yazma ve EXIT 12 ver (conarium-verify'daki seq gap ile aynı anlam).
  // --allow-gaps yalnızca ozgunluk sorusu (a) sorulduğunda EXIT 0 döndürür.
  if (!d.chain.contiguous && !opts.allowGaps) {
    const gapDesc = d.chain.gaps
      .map((g) => `seq ${g.expectedSeq} (found ${g.foundSeq})`)
      .join(', ')
    const msg =
      `chain has ${d.chain.gaps.length} gap(s): ${gapDesc}; ` +
      `receipt chain is NOT contiguous — coverage is incomplete. ` +
      `(use --allow-gaps to verify authenticity only)`
    fail(12, msg, opts.json, { gaps: d.chain.gaps })
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, code: 0, declaration: d.id, version: d.v }))
  } else {
    const unassigned = d.v === COVERAGE_V ? d.coverage.unassignedReceiptCount : 0
    console.log(
      `ok: coverage declaration ${d.id} verified (version ${d.v}, ${d.chain.count} receipts, ` +
        `contiguous=${d.chain.contiguous}, accessed=${d.coverage.accessed}, ` +
        `notRecorded=${d.coverage.notRecorded})`,
    )
    // Belirsizlik uyarısı: notRecorded listesi ancak unassigned=0 iken "kesin" sayılabilir.
    // "erişilmedi"/"not accessed" ifadesi YASAK — kaydın yokluğu belirsizdir, erişim yokluğu değil.
    if (unassigned > 0) {
      console.warn(
        `warning: notRecorded=${d.coverage.notRecorded} (${unassigned} receipt(s) could not be attributed ` +
          `to a specific object; this list is NOT definitive)`,
      )
    }
  }
  process.exit(0)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('conarium-coverage.mjs') ||
    process.argv[1].endsWith('conarium-coverage'))

if (isDirect) {
  main().catch((err) => {
    console.error(err)
    process.exit(20)
  })
}
