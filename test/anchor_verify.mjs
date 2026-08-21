/**
 * A6.5–A6.7 — conarium-verify --anchor-check with committed OpenTimestamps fixtures.
 * No TESTOTS stubs in the verifier. Fixtures under test/fixtures/ots/ (no private keys).
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERIFY = join(ROOT, 'bin', 'conarium-verify.mjs')
const FIX = join(ROOT, 'test', 'fixtures', 'ots')

function runVerify(args) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' }
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-av-'))
  const pub = join(FIX, 'pubkey.pem')
  const chainPending = readFileSync(join(FIX, 'chain-pending.jsonl'), 'utf-8').trim()
  const receipt = JSON.parse(chainPending)
  const matchingOtsB64 = readFileSync(join(FIX, 'pending-matching.ots')).toString('base64')
  const wrongOtsB64 = readFileSync(join(FIX, 'other-ffff.ots')).toString('base64')

  // A6.5 — every anchor null: skipped, and then nothing is left to compare.
  //
  // This expectation was 0 until 0.2.40, and the reasoning behind it was half
  // right. A null anchor must not fail — periodic anchoring leaves most receipts
  // null, and failing on that would make the flag unusable. But skipping every
  // one and then exiting 0 answers the caller's question ("do the anchors hold?")
  // from a code path that never reached an anchor. The count was always printed,
  // so the information was on screen; the exit code was the part that claimed
  // more than had been examined, and the exit code is what a machine reads.
  //
  // 15 already means "could not be checked" and is evaluated ahead of 14 so that
  // "I could not check" is never swallowed by "it does not hold". This is that
  // value, used for the case it was defined for. The behaviour changed rather
  // than the expectation staying, which is the opposite of vector 008 — there
  // the implementation was right and the test was wrong; here the test had
  // written down the defect.
  const chainPath = join(dir, 'chain.jsonl')
  const anchorsPath = `${chainPath}.anchors.jsonl`
  writeFileSync(chainPath, JSON.stringify({ ...receipt, anchor: null }) + '\n')
  let res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 15, `A6.5 expected 15 (nothing compared), got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /0\/1 anchored/)
  assert.match(res.stderr, /nothing was compared/)

  // A6.6 — real pending OTS matching chain.hash → 0 + warning
  // verify() may contact calendars for attestation status; digest already matches offline.
  writeFileSync(chainPath, JSON.stringify(receipt) + '\n')
  writeFileSync(
    anchorsPath,
    JSON.stringify({
      seq: receipt.chain.seq,
      hash: receipt.chain.hash,
      log: 'opentimestamps',
      ots: matchingOtsB64,
      state: 'pending',
      submittedAt: '2026-07-29T00:00:00.000Z',
      upgradedAt: null,
      bitcoinBlock: null,
    }) + '\n',
  )
  res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  // 0 VEYA 15 — ikisi de dogru cevap, cunku bu adim aga cikabilir.
  //
  // Bu test 2026-08-08'de CI'yi RASTGELE kirmizi yakiyordu: takvime
  // ulasilamadiginda dogrulayici 14 ("kanit basarisiz") donuyordu ve test 0
  // bekliyordu. Yerelde ag calistigi icin yesildi, CI'da degildi. Kok neden
  // testin kirilganligi degil, dogrulayicinin "ulasamadim" ile "gecersiz"i
  // ayni saymasiydi; 15 eklenerek duzeltildi.
  //
  // Simdi test ikisini de kabul ediyor ama SESSIZCE degil: 15 ise gerekcesinin
  // ulasilamama oldugunu dogruluyor. Aksi halde gercek bir kanit hatasi
  // "ag yoktu herhalde" diye gecerdi.
  if (res.code === 15) {
    assert.match(res.stderr, /could not be checked/, `A6.6: 15 dondu ama gerekce ulasilamama degil: ${res.stderr}`)
  } else {
    assert.equal(res.code, 0, `A6.6 expected 0 or 15, got ${res.code}: ${res.stderr}`)
    assert.match(res.stderr, /anchor pending/)
  }

  // A6.7 — OTS for a different digest → 14
  writeFileSync(
    anchorsPath,
    JSON.stringify({
      seq: receipt.chain.seq,
      hash: receipt.chain.hash,
      log: 'opentimestamps',
      ots: wrongOtsB64,
      state: 'pending',
      submittedAt: '2026-07-29T00:00:00.000Z',
      upgradedAt: null,
      bitcoinBlock: null,
    }) + '\n',
  )
  res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.7 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor proof failed|does not match|File does not match/i)

  // A6.8 — ince OTS istemcisi YANINDA DEGILSE: 15, 14 DEGIL.
  //
  // "Kontrol edemedim" ile "kanit gecersiz" ayni sey degildir. verify.mjs
  // dist/ots/client.js'i dinamik import eder; yalnizca bu dosya kopyalaninca
  // istemci yok — gercek bir "kontrol edemedim" kurulumu, stub'siz.
  const isolatedDir = mkdtempSync(join(tmpdir(), 'cnr-noots-'))
  const isolatedVerify = join(isolatedDir, 'conarium-verify.mjs')
  writeFileSync(isolatedVerify, readFileSync(VERIFY, 'utf-8'))
  writeFileSync(
    anchorsPath,
    JSON.stringify({
      seq: receipt.chain.seq,
      hash: receipt.chain.hash,
      log: 'opentimestamps',
      ots: matchingOtsB64,
      state: 'pending',
      submittedAt: '2026-07-29T00:00:00.000Z',
      upgradedAt: null,
      bitcoinBlock: null,
    }) + '\n',
  )
  const isolated = spawnSync(
    process.execPath,
    [isolatedVerify, chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const isoCode = isolated.status ?? 1
  assert.equal(isoCode, 15, `A6.8 expected 15 (could not check), got ${isoCode}: ${isolated.stderr}`)
  assert.match(isolated.stderr, /could not be checked/)
  assert.match(isolated.stderr, /not available|not installed/)
  // And it must NOT be 0: the caller has to know the anchor was not verified.
  assert.notEqual(isoCode, 0, 'A6.8: returning 0 silently would show something unmeasured as verified')

  // ── A6.9 — --anchor-check that reaches no anchor at all ───────────────────
  // Every receipt carries anchor: null, so each one is skipped as designed
  // (periodic anchoring leaves most of them null and failing would be wrong).
  // The bug was what came after: the run then reported success, having compared
  // nothing. A caller who asked whether the anchors held was told yes by a code
  // path that never reached one — a verdict on an input it never examined.
  // 15 already means "could not be checked" and is the answer here.
  const VECTORS = join(ROOT, 'test-vectors')
  const unanchored = join(VECTORS, '002-chain-of-three', 'receipts.jsonl')
  const pubkey = join(VECTORS, 'keys', 'vector-key.pub.pem')

  const carriesNoAnchor = readFileSync(unanchored, 'utf-8')
    .trim()
    .split('\n')
    .every((l) => JSON.parse(l).anchor === null)
  assert.ok(carriesNoAnchor, 'A6.9 fixture assumption: every receipt in 002 is unanchored')

  const nothingCompared = runVerify([unanchored, '--pubkey', pubkey, '--anchor-check'])
  assert.equal(
    nothingCompared.code,
    15,
    `A6.9 expected 15 (nothing compared), got ${nothingCompared.code}: ${nothingCompared.stderr}`,
  )
  assert.match(nothingCompared.stderr, /nothing was compared/)

  // The same chain without --anchor-check is a clean 0: the fix must not turn a
  // verifier that was never asked about anchors into one that complains.
  const notAsked = runVerify([unanchored, '--pubkey', pubkey])
  assert.equal(notAsked.code, 0, `A6.9 control: no anchor flag must stay 0, got ${notAsked.code}`)

  // --require-head-anchor keeps 14. The caller asserted an anchor must be there;
  // its absence is a failed assertion, not an unread one, and collapsing the two
  // would lose exactly the distinction this check exists to defend.
  const required = runVerify([unanchored, '--pubkey', pubkey, '--anchor-check', '--require-head-anchor'])
  assert.equal(required.code, 14, `A6.9 expected 14 under --require-head-anchor, got ${required.code}`)

  console.log('anchor-verify tests OK (real OTS fixtures)')
}

main()
