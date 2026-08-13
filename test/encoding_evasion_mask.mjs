/**
 * Encoding-evasion + wrapped-token content scanner (paket #12 / G3+G4).
 *
 * #11 measured on published 0.2.3: ZWSP inside a valid IBAN made the IBAN
 * scanner miss, the digit scanner ate the tail, and the model saw
 * `TR33<ZWSP>000610051[MASKED_PII]` with maskedCount: 1.
 *
 * KIRMA: set normalizePiiText to identity (`return input`). Then
 *   - `normalizePiiText('a\\u200bb') === 'ab'` goes red
 *   - the ZWSP-IBAN case leaves a TR prefix and this file exits 1
 */
import assert from 'assert/strict'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const govJs = path.join(here, '..', 'dist', 'governance.js')
const normJs = path.join(here, '..', 'dist', 'pii_normalize.js')
const llmJs = path.join(here, '..', 'dist', 'llm-gate.js')
assert.ok(existsSync(govJs), 'dist/governance.js missing — test:checks runs build first')

const { Governance } = await import(pathToFileURL(govJs).href)
const { normalizePiiText } = await import(pathToFileURL(normJs).href)
const { governLlm } = await import(pathToFileURL(llmJs).href)

const TR = 'TR330006100519786457841326'
const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('KIRMA: normalizePiiText is not identity (ZWSP must disappear)', () => {
  // If someone deletes the strip, this is the first assert that goes red.
  assert.equal(normalizePiiText('a\u200bb'), 'ab')
  assert.equal(normalizePiiText('a\u200cb'), 'ab')
  assert.equal(normalizePiiText('a\u200db'), 'ab')
  assert.equal(normalizePiiText('\uFEFFhi'), 'hi')
  assert.equal(normalizePiiText('soft\u00ADhyphen'), 'softhyphen')
  assert.equal(normalizePiiText('x＠y.com'), 'x@y.com')
  assert.equal(normalizePiiText('１２３'), '123')
  assert.equal(normalizePiiText('4111\u20101111'), '4111-1111')
})

test('conscious output change: ZWSP gone even when nothing is PII', () => {
  const r = gov.maskPII('merhaba\u200b dunya')
  assert.equal(r.masked, 'merhaba dunya')
  assert.equal(r.count, 0)
})

test('ZWSP IBAN is fully masked — no TR prefix, count is honest', () => {
  const input = `havale TR33\u200b0006100519786457841326 tamam`
  const r = gov.maskPII(input)
  const out = String(r.masked)
  assert.equal(out, 'havale [MASKED_PII] tamam')
  assert.ok(!/TR/i.test(out), `partial mask leaked prefix: ${out}`)
  assert.ok(!/000610051/.test(out), `partial mask leaked digits: ${out}`)
  assert.ok(r.count >= 1)
  // Must not look like "I masked it" while a country code remains.
  assert.ok(!/[A-Z]{2}\d/.test(out))
})

test('governLlm path: ZWSP IBAN + maskedCount does not lie', async () => {
  let seen = ''
  let audit = null
  const gated = governLlm(async (p) => {
    seen = p
    return 'ok'
  }, {}, (a) => {
    audit = a
  })
  await gated(`havale ${'TR33'}\u200b${'0006100519786457841326'} tamam`)
  assert.equal(seen, 'havale [MASKED_PII] tamam')
  assert.ok(audit && audit.maskedCount >= 1)
  assert.ok(!/TR33/.test(seen))
})

test('ZWSP email is masked', () => {
  const r = gov.maskPII('yaz patron\u200b@sirket.com')
  assert.equal(r.masked, 'yaz [MASKED_PII]')
  assert.ok(r.count >= 1)
})

test('fullwidth ＠ email is masked', () => {
  const r = gov.maskPII('yaz patron＠sirket.com')
  assert.equal(r.masked, 'yaz [MASKED_PII]')
  assert.ok(r.count >= 1)
})

test('unicode-dash card is masked', () => {
  const r = gov.maskPII('kart 4111\u20101111\u20101111\u20101111')
  const out = String(r.masked)
  assert.ok(out.includes('[MASKED_PII]'))
  assert.ok(!/4111/.test(out), out)
  assert.ok(r.count >= 1)
})

test('fullwidth TCKN is masked', () => {
  const full = '12345678901'
    .split('')
    .map((d) => String.fromCharCode(0xff10 + Number(d)))
    .join('')
  const r = gov.maskPII(`tckn ${full}`)
  assert.equal(r.masked, 'tckn [MASKED_PII]')
  assert.ok(r.count >= 1)
})

test('wrapped base64 token that decodes to email is masked', () => {
  const b64 = Buffer.from('patron@sirket.com').toString('base64')
  const r = gov.maskPII(`encoded: ${b64}`)
  const out = String(r.masked)
  assert.ok(out.includes('[MASKED_PII]'))
  assert.ok(!out.includes(b64), out)
  assert.ok(r.count >= 1)
})

test('wrapped hex token that decodes to email is masked', () => {
  const hex = Buffer.from('patron@sirket.com').toString('hex')
  const r = gov.maskPII(`payload ${hex} end`)
  const out = String(r.masked)
  assert.ok(out.includes('[MASKED_PII]'))
  assert.ok(!out.includes(hex), out)
  assert.ok(r.count >= 1)
})

test('non-PII base64 / hash are left alone', () => {
  const hello = Buffer.from('merhaba dunya bugun hava cok guzel').toString('base64')
  const r1 = gov.maskPII(`encoded: ${hello}`)
  assert.equal(r1.masked, `encoded: ${hello}`)
  assert.equal(r1.count, 0)

  const hash = createHash('sha256').update('conarium').digest('hex')
  const r2 = gov.maskPII(`digest ${hash}`)
  assert.equal(r2.masked, `digest ${hash}`)
  assert.equal(r2.count, 0)
})

test('false-positive brake: date, amount, order no, checksum-fail IBAN', () => {
  const invalid = 'TR000000000000000000000000'
  const r = gov.maskPII(
    `ref ${invalid} tutar 1500.50 TL tarih 2026-08-13 siparis ORD-2026-00412`,
  )
  const out = String(r.masked)
  assert.ok(out.includes(invalid), 'checksum-fail IBAN must survive')
  assert.ok(out.includes('1500.50'))
  assert.ok(out.includes('2026-08-13'))
  assert.ok(out.includes('ORD-2026-00412'))
  assert.equal(r.count, 0)
})

test('plain valid IBAN still fully masked (regression)', () => {
  const r = gov.maskPII(`havale ${TR} tamam`)
  assert.equal(r.masked, 'havale [MASKED_PII] tamam')
})

test('ReDoS: 20k pathological input stays in the same band as A6', () => {
  const blob = `${'@'.repeat(10000)} ${'4111 '.repeat(4000)}${'TR00 '.repeat(4000)}`
  const t0 = performance.now()
  gov.maskPII(blob)
  const ms = performance.now() - t0
  assert.ok(ms < 250, `maskPII pathological input took ${ms.toFixed(1)}ms (budget 250ms; A6 was 0.2–1.2ms on smaller inputs)`)
})

for (const { name, fn } of tests) {
  try {
    await fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}\n        ${err.message}`)
  }
}
console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
process.exit(failCount > 0 ? 1 : 0)
