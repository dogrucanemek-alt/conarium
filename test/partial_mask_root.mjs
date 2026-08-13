/**
 * G1 acceptance table (paket #14) + 0.2.4 regression lock.
 *
 * KIRMA: drop `(?<!\d)` / `(?!\d)` from PHONE_FORMATTED, or drop the
 * all-digits skip in maskNumericPii. Then
 *   assert.equal(maskPII('4111111111111111').masked, '[MASKED_PII]')
 * goes red (`411[MASKED_PII]`). That is the prefix-lie this cut exists to stop.
 */
import assert from 'assert/strict'
import { existsSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const govJs = path.join(here, '..', 'dist', 'governance.js')
const capJs = path.join(here, '..', 'dist', 'digit_pii.js')
assert.ok(existsSync(govJs), 'dist/governance.js missing — test:checks runs build first')

const { Governance } = await import(pathToFileURL(govJs).href)
const { PII_SCAN_CHAR_CAP, luhnOk } = await import(pathToFileURL(capJs).href)
const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('4111111111111111 Luhn-valid → full mask, no digits', () => {
  assert.equal(luhnOk('4111111111111111'), true)
  const r = gov.maskPII('4111111111111111')
  assert.equal(r.masked, '[MASKED_PII]')
  assert.equal(r.count, 1)
  assert.equal(String(r.masked).match(/\d/), null)
})

test('1234567890123456 Luhn-invalid → not a card, untouched', () => {
  assert.equal(luhnOk('1234567890123456'), false)
  const r = gov.maskPII('1234567890123456')
  assert.equal(r.masked, '1234567890123456')
  assert.equal(r.count, 0)
})

test('20-digit order → untouched, count 0', () => {
  const r = gov.maskPII('12345678901234567890')
  assert.equal(r.masked, '12345678901234567890')
  assert.equal(r.count, 0)
})

test('TCKN 11-digit isolated → full mask', () => {
  const r = gov.maskPII('12345678901')
  assert.equal(r.masked, '[MASKED_PII]')
  assert.equal(r.count, 1)
})

test('KIRMA: 16-digit PAN must not leave a prefix glued to the mask', () => {
  const r = gov.maskPII('4111111111111111')
  assert.doesNotMatch(String(r.masked), /\d\[MASKED_PII\]/)
})

test('0.2.4 regression: ZWSP IBAN / email / ＠ / fullwidth TCKN still full-mask', () => {
  const iban = gov.maskPII('havale TR33\u200b0006100519786457841326 tamam')
  assert.equal(iban.masked, 'havale [MASKED_PII] tamam')
  const mail = gov.maskPII('yaz patron\u200b@sirket.com')
  assert.equal(mail.masked, 'yaz [MASKED_PII]')
  const homo = gov.maskPII('yaz patron＠sirket.com')
  assert.equal(homo.masked, 'yaz [MASKED_PII]')
  const full = '12345678901'.split('').map((d) => String.fromCharCode(0xff10 + Number(d))).join('')
  const tckn = gov.maskPII(`tckn ${full}`)
  assert.equal(tckn.masked, 'tckn [MASKED_PII]')
})

test('cap: oversize is masked, not skipped', () => {
  const r = gov.maskPII('1'.repeat(PII_SCAN_CHAR_CAP + 1))
  assert.equal(r.masked, '[MASKED_PII]')
  assert.equal(r.count, 1)
})

test('entity email masked; non-email entity intact', () => {
  const hit = gov.maskPII('yaz patron&#64;sirket.com')
  assert.equal(hit.masked, 'yaz [MASKED_PII]')
  const miss = gov.maskPII('fiyat 5&#64; magaza')
  assert.equal(miss.masked, 'fiyat 5&#64; magaza')
  assert.equal(miss.count, 0)
})

for (const { name, fn } of tests) {
  try {
    fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}\n        ${err.message}`)
  }
}
console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
process.exit(failCount > 0 ? 1 : 0)
