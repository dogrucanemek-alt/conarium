#!/usr/bin/env node
/**
 * EXAMPLE_ALLOW strips the example, then scans the residue.
 * A legitimate PII line stays green; example + internal note must go red.
 */
import assert from 'node:assert/strict'
import { localeResidueFails } from './claim_discipline.mjs'

const cases = [
  { id: 'plain-internal-note', line: 'Teslim edilemeyen bir madde karta girmez.', want: 'RED' },
  { id: 'legitimate-pii-example', line: '`Sn. Ahmet Yılmaz`, `Yetkili: Ayşe Demir`, `customer: John Smith`', want: 'GREEN' },
  { id: 'example-plus-note', line: 'Yetkili: Ayşe Demir — Teslim edilemeyen bir madde karta girmez.', want: 'RED' },
  { id: 'gunes-plus-note', line: 'Güneş — Teslim edilemeyen bir madde karta girmez.', want: 'RED' },
  { id: 'zincir-plus-note', line: 'It writes zincir sağlam — Teslim edilemeyen bir madde karta girmez.', want: 'RED' },
]

let failed = 0
for (const c of cases) {
  const red = localeResidueFails(c.line)
  const got = red ? 'RED' : 'GREEN'
  const ok = got === c.want
  if (!ok) failed += 1
  console.log(`${ok ? 'ok' : 'FAIL'}  ${c.id.padEnd(24)} want=${c.want} got=${got}`)
}

assert.equal(failed, 0, `${failed} locale allowlist case(s) wrong`)
console.log('locale allow strip: 5/5')
