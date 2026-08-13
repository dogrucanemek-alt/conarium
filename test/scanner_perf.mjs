/**
 * Scanner cost: same inputs the gate measured on 0.2.3/0.2.4.
 * Prints a timing table. Fails if TR33+40k stays in the 1s band, or if the
 * cap skips (returns the original) instead of masking.
 */
import assert from 'assert/strict'
import { existsSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const govJs = path.join(here, '..', 'dist', 'governance.js')
const capJs = path.join(here, '..', 'dist', 'digit_pii.js')
assert.ok(existsSync(govJs), 'dist missing')

const { Governance } = await import(pathToFileURL(govJs).href)
const { PII_SCAN_CHAR_CAP } = await import(pathToFileURL(capJs).href)
const gov = new Governance({})

function time(fn, n = 3) {
  const t0 = performance.now()
  let last
  for (let i = 0; i < n; i++) last = fn()
  return { ms: (performance.now() - t0) / n, last }
}

const rows = [
  ['TR33+20k digits', 'TR33' + '1'.repeat(20000)],
  ['TR33+40k digits', 'TR33' + '1'.repeat(40000)],
  ['10k ZWSP', '\u200b'.repeat(10000)],
  ['20k hex', 'ab'.repeat(10000)],
  ['12k digits (under cap)', '1'.repeat(12000)],
]

console.log('PII_SCAN_CHAR_CAP', PII_SCAN_CHAR_CAP)
console.log('input'.padEnd(28), 'ms'.padStart(8), 'count', 'out')
for (const [label, input] of rows) {
  const { ms, last } = time(() => gov.maskPII(input))
  const out = String(last.masked)
  const preview = out.length > 40 ? out.slice(0, 24) + '…' + out.length : out
  console.log(label.padEnd(28), ms.toFixed(1).padStart(8), String(last.count).padStart(5), preview)
  if (input.length > PII_SCAN_CHAR_CAP) {
    assert.equal(last.masked, '[MASKED_PII]', `${label} over cap must fail-closed, not skip`)
    assert.equal(last.count, 1)
  }
}

const under = gov.maskPII('1'.repeat(12000))
assert.equal(under.count, 0, '12k digits are not a card')
assert.equal(String(under.masked), '1'.repeat(12000))
const { ms: underMs } = time(() => gov.maskPII('1'.repeat(12000)), 5)
console.log('12k-digit linear budget', underMs.toFixed(1), 'ms')
assert.ok(underMs < 50, `12k digits took ${underMs.toFixed(1)}ms (email backtrack not linearised?)`)

const { ms: huge } = time(() => gov.maskPII('TR33' + '1'.repeat(40000)), 5)
assert.ok(huge < 50, `TR33+40k took ${huge.toFixed(1)}ms after cap; expected fail-closed`)

const { normalizePiiText, maskEmbeddedEncodedPii, collapsePartialMask } = await import(pathToFileURL(path.join(here, '..', 'dist', 'pii_normalize.js')).href)
const { maskEmails, maskNumericPii } = await import(pathToFileURL(capJs).href)
const { prepareIbanPass, maskIbansInText } = await import(pathToFileURL(path.join(here, '..', 'dist', 'iban.js')).href)
const d12 = '1'.repeat(12000)
const stages = [
  ['normalizePiiText', () => normalizePiiText(d12)],
  ['prepareIbanPass', () => prepareIbanPass(d12)],
  ['maskEmails', () => maskEmails(d12)],
  ['maskNumericPii', () => maskNumericPii(d12)],
  ['collapsePartialMask', () => collapsePartialMask(d12)],
  ['maskEmbeddedEncodedPii', () => maskEmbeddedEncodedPii(d12, (s) => maskIbansInText(s).count > 0)],
  ['maskPII full', () => gov.maskPII(d12)],
]
console.log('stage profile (12k digits)')
for (const [name, fn] of stages) {
  const { ms } = time(fn, 5)
  console.log('  ', name.padEnd(24), ms.toFixed(2), 'ms')
}
console.log('OK  scanner_perf')
