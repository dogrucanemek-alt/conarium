/**
 * Every case must carry a non-empty doesNotTest. An empty string is a lie.
 */
import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED = ['id', 'regime', 'profile', 'claim', 'rationale', 'doesNotTest']
const REGIMES = new Set(['conformance', 'resistance'])
const PROFILES = new Set(['GACS-D1', 'GACS-E1', 'GACS-C1', 'GACS-I1'])

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.json')) acc.push(p)
  }
  return acc
}

function load(file) {
  return { file, case: JSON.parse(readFileSync(file, 'utf8')) }
}

function validate(c, file) {
  for (const k of REQUIRED) {
    assert.ok(c[k] != null && String(c[k]).trim() !== '', `${file}: missing ${k}`)
  }
  assert.ok(REGIMES.has(c.regime), `${file}: bad regime`)
  assert.ok(PROFILES.has(c.profile), `${file}: bad profile`)
  if (c.doesNotTest.trim() === '') throw new Error(`${file}: doesNotTest empty`)
}

const files = walk(join('conformance', 'cases'))
assert.ok(files.length >= 46, `expected ≥46 cases, got ${files.length}`)
for (const file of files) validate(load(file).case, file)

const hollow = {
  id: 'gate/hollow',
  regime: 'conformance',
  profile: 'GACS-E1',
  claim: 'table-policy',
  rationale: 'x',
  doesNotTest: '',
}
assert.throws(() => validate(hollow, 'hollow'), /doesNotTest/)
console.log(`gacs case schema: ${files.length} cases, empty doesNotTest rejected`)
