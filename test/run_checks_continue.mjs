/**
 * A failing check must not silence the rest.
 *
 * Deliberately breaks the first file, then asserts the second still ran
 * and a missing third is reported as skipped.
 */
import assert from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runChecks, summarize, formatReport } from './run-checks.mjs'

const dir = mkdtempSync(join(tmpdir(), 'conarium-checks-'))
writeFileSync(join(dir, 'fail.mjs'), 'console.log("fail-check ran"); process.exit(1)\n')
writeFileSync(join(dir, 'pass.mjs'), 'console.log("pass-check ran"); process.exit(0)\n')

const results = runChecks({
  files: ['fail.mjs', 'pass.mjs', 'missing.mjs'],
  cwd: dir,
})

assert.strictEqual(results.length, 3, 'all three entries must be recorded')
assert.strictEqual(results[0].status, 'failed', 'first check must fail')
assert.ok(results[0].stdout.includes('fail-check ran'), 'failing check must have executed')
assert.strictEqual(results[1].status, 'passed', 'second check must still run after a failure')
assert.ok(results[1].stdout.includes('pass-check ran'), 'passing check was skipped — the chain is still &&')
assert.strictEqual(results[2].status, 'skipped', 'missing file must be skipped, not silently omitted')

const s = summarize(results)
assert.strictEqual(s.ran, 2)
assert.strictEqual(s.passed, 1)
assert.strictEqual(s.failed, 1)
assert.strictEqual(s.skipped, 1)

const report = formatReport(results)
assert.strictEqual(report.exit, 1)
assert.ok(report.lines.some((l) => l.startsWith('FAIL') && l.includes('fail.mjs')))
assert.ok(report.lines.some((l) => l.startsWith('PASS') && l.includes('pass.mjs')))
assert.ok(report.lines.some((l) => l.startsWith('SKIPPED') && l.includes('missing.mjs')))
assert.ok(report.lines.some((l) => /2 ran, 1 passed, 1 failed, 1 skipped/.test(l)))

const runner = fileURLToPath(new URL('./run-checks.mjs', import.meta.url))
const cli = spawnSync(
  process.execPath,
  [runner, '--files', 'fail.mjs,pass.mjs,missing.mjs'],
  { cwd: dir, encoding: 'utf-8' },
)
assert.strictEqual(cli.status, 1, `CLI must exit 1 when any check fails:\n${cli.stdout}\n${cli.stderr}`)
assert.ok(/FAIL\s+fail\.mjs/.test(cli.stdout), `CLI missing FAIL line:\n${cli.stdout}`)
assert.ok(/fail-check ran/.test(cli.stdout), 'CLI must still execute the failing file')
assert.ok(/PASS\s+pass\.mjs/.test(cli.stdout), 'CLI skipped the rest after a failure')
assert.ok(/SKIPPED\s+missing\.mjs/.test(cli.stdout), 'CLI must print SKIPPED for a missing file')
assert.ok(/2 ran, 1 passed, 1 failed, 1 skipped/.test(cli.stdout))

console.log('PASS  ::  failing check does not skip the rest')
console.log('Summary: 1 passed, 0 failed')
process.exit(0)
