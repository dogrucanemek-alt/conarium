/**
 * conarium-suggest-policy — prints a maskColumns guess, never writes config.
 */
import assert from 'assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const BIN = path.join(root, 'bin', 'conarium-suggest-policy.mjs')
const SEED = path.join(root, 'examples', 'demo-bank', 'seed.sql')
const CONFIG = path.join(root, 'conarium.config.json')

function run(args, extra = {}) {
  const win = process.platform === 'win32'
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: root,
    shell: false,
    ...extra,
  })
}

const help = run(['--help'])
assert.equal(help.status, 0, help.stderr)
assert.match(help.stderr + help.stdout, /does not write config/i)

const missing = run([])
assert.equal(missing.status, 2)

const writeFlag = run(['--sql', SEED, '--write'])
assert.equal(writeFlag.status, 1)
assert.match(writeFlag.stderr, /does not write config/)

const text = run(['--sql', SEED])
assert.equal(text.status, 0, text.stderr)
assert.match(text.stdout, /This is a guess; it looks at column names, not data/)
assert.match(text.stdout, /wroteConfig: false/)
assert.match(text.stdout, /\*\.holder_name/)
assert.match(text.stdout, /\*\.tckn/)
assert.match(text.stdout, /\*\.iban/)
assert.match(text.stdout, /\*\.pan/)
assert.match(text.stdout, /\*\.cvv/)
assert.doesNotMatch(text.stdout, /balance_try/)
assert.doesNotMatch(text.stdout, /amount_try/)

const json = run(['--sql', SEED, '--json'])
assert.equal(json.status, 0, json.stderr)
const body = JSON.parse(json.stdout)
assert.equal(body.wroteConfig, false)
assert.equal(body.honesty, 'This is a guess; it looks at column names, not data.')
assert.ok(body.maskColumns.includes('*.holder_name'))
assert.ok(body.maskColumns.includes('*.tckn'))
assert.ok(!body.maskColumns.includes('*.balance_try'))

const dir = mkdtempSync(path.join(tmpdir(), 'conarium-suggest-'))
const copy = path.join(dir, 'conarium.config.json')
copyFileSync(CONFIG, copy)
const before = createHash('sha256').update(readFileSync(copy)).digest('hex')
const againstCopy = run(['--sql', SEED, '--json'], { cwd: dir })
assert.equal(againstCopy.status, 0, againstCopy.stderr)
const after = createHash('sha256').update(readFileSync(copy)).digest('hex')
assert.equal(after, before, 'suggest-policy must not write conarium.config.json')

const marker = path.join(dir, 'untouched.txt')
writeFileSync(marker, 'keep')
assert.equal(readFileSync(marker, 'utf8'), 'keep')

console.log('PASS  ::  suggest-policy demo-bank + wroteConfig false')
process.exit(0)
