/**
 * The stamper replaces files in one step, and asks the file system once.
 *
 * CodeQL found this on 21 August 2026 (js/file-system-race): the anchor record
 * was checked for existence and then written, and the chain was rewritten by
 * truncation while the /proof route was handing that same file to visitors. The
 * route's own comment calls that window "a real window, not a theory".
 *
 * A race cannot be forced deterministically from a test, so this check pins the
 * two things that can be: the behaviour after the change, and the shape of the
 * writes. The vulnerability class itself stays CodeQL's job. Restoring either
 * `existsSync` or a direct `writeFileSync` on a published path turns the last
 * case red.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.CONARIUM_ROOT = process.env.CONARIUM_ROOT || process.cwd()

const ANCHOR_SOURCE = join(process.cwd(), 'deploy', 'hetzner', 'proof-service', 'deploy', 'proof-anchor.mjs')
const { stampDemoHead } = await import(pathToFileURL(ANCHOR_SOURCE).href)

const HASH = 'sha256:' + 'ab'.repeat(32)
const OTS = Buffer.from('ots-bytes-for-the-test')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'conarium-anchor-'))
  const chainPath = join(dir, 'chain.jsonl')
  const anchorPath = join(dir, 'anchor.json')
  writeFileSync(chainPath, JSON.stringify({ chain: { seq: 1, hash: HASH } }) + '\n')
  return { dir, chainPath, anchorPath }
}

const opts = (f) => ({
  chainPath: f.chainPath,
  anchorPath: f.anchorPath,
  stamp: async () => OTS,
  upgrade: async () => ({ changed: false, otsBytes: OTS, bitcoinBlock: null }),
})

const tmpLeftovers = (dir) => readdirSync(dir).filter((n) => n.includes('.tmp-'))

// 1) No anchor record yet — the read answers that, and nothing is left behind.
const fresh = fixture()
const first = await stampDemoHead(opts(fresh))
assert.equal(first.ref, HASH)
assert.equal(first.state, 'pending')
assert.equal(JSON.parse(readFileSync(fresh.anchorPath, 'utf8')).ref, HASH)
assert.deepEqual(tmpLeftovers(fresh.dir), [], 'a rename was skipped and a temporary file survived')

// 2) An anchor record that cannot be parsed is the same case as none at all.
const corrupt = fixture()
writeFileSync(corrupt.anchorPath, '{ this is not json')
const second = await stampDemoHead(opts(corrupt))
assert.equal(second.ref, HASH)
assert.equal(JSON.parse(readFileSync(corrupt.anchorPath, 'utf8')).ref, HASH)

// 3) The chain keeps its one receipt and carries the anchor on its head.
const lines = readFileSync(corrupt.chainPath, 'utf8').split(/\r?\n/).filter(Boolean)
assert.equal(lines.length, 1)
assert.equal(JSON.parse(lines[0]).anchor.ref, HASH)
assert.deepEqual(tmpLeftovers(corrupt.dir), [])

rmSync(fresh.dir, { recursive: true, force: true })
rmSync(corrupt.dir, { recursive: true, force: true })

// 4) The shape. Every file this module publishes is read by something else while
// it runs, so each one is replaced by rename, and existence is never a question
// asked separately from the read that follows it.
const source = readFileSync(ANCHOR_SOURCE, 'utf8')
assert.ok(
  !/\bexistsSync\b/.test(source),
  'proof-anchor.mjs asks whether a file exists separately from the read that follows it',
)
const truncating = source
  .split(/\r?\n/)
  .map((line, i) => [i + 1, line.trim()])
  .filter(([, line]) => /\bwriteFileSync\(/.test(line) && !/writeFileSync\(tmp,/.test(line))
assert.deepEqual(
  truncating,
  [],
  'a published path is written by truncation instead of rename: ' + JSON.stringify(truncating),
)

console.log('ok: anchor and chain are replaced by rename, and existence is never asked separately')
