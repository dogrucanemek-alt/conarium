/**
 * C4 — offline countersign verifier.
 * RED 2026-08-15: bin/conarium-countersign-verify.mjs does not exist.
 */
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import request from 'supertest'
import { createPrivateKey } from 'node:crypto'
import { createAnchorService } from '../dist/anchor-service.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'conarium-countersign-verify.mjs')

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' }
}

const dir = mkdtempSync(join(tmpdir(), 'cnr-csig-'))
const pair = generateKeyPairSync('ed25519')
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const pubPath = join(dir, 'key.pub.pem')
writeFileSync(pubPath, publicPem)
writeFileSync(pubPath + '.keyid', 'c4-test-key\n')

const { app, readStore } = createAnchorService({
  storePath: join(dir, 'anchors.jsonl'),
  tokens: new Map([['tok', 'acme']]),
  publicBaseUrl: 'https://anchor.example/',
  signingKey: { keyId: 'c4-test-key', privateKey: createPrivateKey(privatePem) },
  stamp: async () => Buffer.from('ots').toString('base64'),
})

const created = await request(app).post('/anchor').set('authorization', 'Bearer tok').send({
  hash: 'sha256:' + 'ab'.repeat(32),
})
assert.equal(created.status, 201, `submit failed: ${created.status} ${created.text}`)
const rec = readStore()[0]
const recPath = join(dir, 'record.json')
writeFileSync(recPath, JSON.stringify(rec) + '\n')

const good = run([recPath, '--pubkey', pubPath])
assert.equal(good.code, 0, `valid countersign expected 0, got ${good.code}: ${good.stderr}`)

// The usage line promises <record.json>. Every case above writes one compact
// line, which is the one shape a person is least likely to produce by hand:
// `curl … | jq . > record.json` yields a pretty-printed object whose first line
// is just "{". That was rejected as "invalid JSON" — valid JSON, our own
// documented input, refused.
const prettyPath = join(dir, 'record.pretty.json')
writeFileSync(prettyPath, JSON.stringify(rec, null, 2) + '\n')
const pretty = run([prettyPath, '--pubkey', pubPath])
assert.equal(pretty.code, 0, `pretty-printed record expected 0, got ${pretty.code}: ${pretty.stderr}`)

const broken = JSON.parse(JSON.stringify(rec))
broken.sig.value = broken.sig.value.replace(/A/g, 'B').replace(/B/g, 'A')
if (broken.sig.value === rec.sig.value) broken.sig.value = 'AAAA'
const brokenPath = join(dir, 'broken.json')
writeFileSync(brokenPath, JSON.stringify(broken) + '\n')
const badSig = run([brokenPath, '--pubkey', pubPath])
assert.equal(badSig.code, 13, `broken sig expected 13, got ${badSig.code}: ${badSig.stderr}`)

const schema = run([join(dir, 'nope.json'), '--pubkey', pubPath])
assert.equal(schema.code, 20, `missing file expected 20, got ${schema.code}: ${schema.stderr}`)

const unreachable = run([recPath, '--pubkey', pubPath, '--log-url', 'http://127.0.0.1:1/anchor/missing'])
assert.equal(unreachable.code, 15, `unreachable log expected 15, got ${unreachable.code}: ${unreachable.stderr}`)
assert.match(unreachable.stderr, /could not be checked|could not check/i)

const inclPath = join(dir, 'inclusion.json')
writeFileSync(inclPath, JSON.stringify(created.body.inclusion) + '\n')
const withIncl = run([recPath, '--pubkey', pubPath, '--inclusion', inclPath])
assert.equal(withIncl.code, 0, `inclusion expected 0, got ${withIncl.code}: ${withIncl.stderr}`)

console.log('PASS  ::  conarium-countersign-verify exit codes 0 / 13 / 15 / 20')
process.exit(0)
