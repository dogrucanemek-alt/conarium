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

  // A6.5 — anchor stripped
  const chainPath = join(dir, 'chain.jsonl')
  const anchorsPath = `${chainPath}.anchors.jsonl`
  writeFileSync(chainPath, JSON.stringify({ ...receipt, anchor: null }) + '\n')
  let res = runVerify([chainPath, '--pubkey', pub, '--anchor-check', '--anchors', anchorsPath])
  assert.equal(res.code, 14, `A6.5 expected 14, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /anchor missing/)

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

  // A6.8 — dogrulayici kurulu DEGILSE: 15, 14 DEGIL.
  //
  // "Kontrol edemedim" ile "kanit gecersiz" ayni sey degildir. Bu, urunun butun
  // gun soyledigi cumlenin (kaydedilmedi != olmadi) dogrulayicinin KENDI icinde
  // uygulanmis hali. Ayrica javascript-opentimestamps 2026-08-12'de opsiyonel
  // bagimliliga tasindi (bagimlilik agacinda duzeltilmemis kritik aciklar vardi),
  // yani bu artik nadir bir kaza degil, siradan bir kurulum hali.
  //
  // Simulasyon yontemi: verify.mjs tek dis bagimlilikli ve gerisi Node built-in.
  // Gecici bir dizine kopyalanip oradan kosuldugunda `javascript-opentimestamps`
  // cozumlenemez — gercek bir "paket yok" kurulumu, stub'siz.
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
  assert.match(isolated.stderr, /not installed/)
  // Ve 0 DONMEMELI: cagiran, cipanin dogrulanMADIGINI bilmek zorunda.
  assert.notEqual(isoCode, 0, 'A6.8: sessizce 0 donmek, olculmemis bir seyi dogrulanmis gostermek olurdu')

  console.log('anchor-verify tests OK (real OTS fixtures)')
}

main()
