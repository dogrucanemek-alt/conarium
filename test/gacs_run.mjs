/**
 * Full suite through the reference adapter. Known gaps must stay listed
 * statuses. Resistance must not say PASS. No score field.
 */
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'gacs-out-'))
const r = spawnSync(
  process.execPath,
  [
    'conformance/run.mjs',
    '--adapter',
    'conformance/adapters/conarium.mjs',
    '--claims',
    'conformance/claims/conarium.json',
    '--out',
    out,
  ],
  { encoding: 'utf8' },
)

const md = r.stdout || ''
const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))

const claimsManifest = JSON.parse(readFileSync('conformance/claims/conarium.json', 'utf8'))
assert.ok(!Object.hasOwn(claimsManifest, 'version'), 'claims.version must be derived from package.json, not written')
assert.equal(report.version, JSON.parse(readFileSync('package.json', 'utf8')).version, 'GACS report version must match package.json')

assert.ok(!Object.hasOwn(report, 'score'), 'report has score')
assert.ok(!Object.hasOwn(report, 'percent'), 'report has percent')
assert.ok(!Object.hasOwn(report, 'grade'), 'report has grade')
assert.ok(report.title.startsWith('GACS report for '), report.title)
assert.match(md, /No single score is produced/)

const resistance = report.results.filter((x) => x.regime === 'resistance')
assert.ok(resistance.every((x) => x.status !== 'PASS'), 'resistance printed PASS')

const byId = Object.fromEntries(report.results.map((x) => [x.id, x]))
assert.strictEqual(byId['inference/count-channel']?.status, 'NOT_COVERED')
assert.strictEqual(byId['inference/exists-channel']?.status, 'NOT_COVERED')
assert.strictEqual(byId['inference/repeated-probe']?.status, 'NOT_COVERED')
assert.strictEqual(byId['inference/cohort-narrowing']?.status, 'NOT_COVERED')
assert.strictEqual(byId['coverage/tail-without-pin']?.status, 'DETECTED_WITH_EXTERNAL_PIN')

const fails = report.results.filter((x) => x.status === 'FAIL' || x.status === 'TOOL_FAILURE' || x.unexpected)
assert.strictEqual(r.status, 0, `runner exit ${r.status}\n${fails.map((f) => `${f.id} ${f.status} ${f.detail || ''}`).join('\n')}\n${md}`)
assert.strictEqual(fails.length, 0, fails.map((f) => `${f.id} ${f.status}`).join(', '))

console.log(`gacs run: ${report.results.length} cases, exit 0, gaps listed`)
