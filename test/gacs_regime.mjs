import assert from 'node:assert'
import {
  conformanceStatus,
  label,
  noScore,
  resistanceStatus,
} from '../conformance/lib/status.mjs'

assert.strictEqual(conformanceStatus({ ok: true }), 'PASS')
assert.strictEqual(conformanceStatus({ ok: false }), 'FAIL')

assert.strictEqual(
  resistanceStatus({ allowed: false, claimListed: true }),
  'ENFORCED',
)
assert.strictEqual(
  resistanceStatus({ allowed: true, claimListed: true }),
  'NOT_COVERED',
)
assert.strictEqual(
  resistanceStatus({ allowed: true, claimListed: false }),
  'NOT_CLAIMED',
)
assert.strictEqual(
  resistanceStatus({
    allowed: true,
    claimListed: true,
    expectedStatus: 'DETECTED_WITH_EXTERNAL_PIN',
  }),
  'DETECTED_WITH_EXTERNAL_PIN',
)

assert.throws(() => label('resistance', 'PASS'), /must not use PASS/)
assert.strictEqual(label('resistance', 'ENFORCED'), 'ENFORCED')
assert.strictEqual(label('conformance', 'PASS'), 'PASS')

assert.throws(() => noScore({ score: 97 }), /single score/)
assert.throws(() => noScore({ percent: 100 }), /single score/)
assert.throws(() => noScore({ grade: 'A' }), /single score/)
noScore({ implementation: 'x', version: '1' })

console.log('gacs regime: PASS locked to conformance; no score')
