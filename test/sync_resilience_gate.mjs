#!/usr/bin/env node
import { createHash, createPrivateKey } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { createAnchorService, loadTokensFile } from '../dist/anchor-service.js'
import { generateKeyPair } from '../dist/keys.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'conarium-resilience-'))
const tokensPath = join(dir, 'tokens.json')
const raw = 'resilience-token-do-not-print'
const sha = createHash('sha256').update(raw).digest('hex')
const initial = JSON.stringify({ _conarium_sync: 't0', [`sha256:${sha}`]: 'owner@example.com' }, null, 2)
writeFileSync(tokensPath, initial)

const pair = generateKeyPair('resilience-key')
const { app } = createAnchorService({
  storePath: join(dir, 'store.jsonl'),
  tokens: loadTokensFile(tokensPath),
  publicBaseUrl: 'https://anchor.example',
  signingKey: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) },
  stamp: async () => Buffer.from('ots').toString('base64'),
  upgrade: async () => ({ upgraded: false }),
})

const health = await request(app).get('/healthz')
const sync = spawnSync(process.execPath, [join(root, 'bin/conarium-token-sync.mjs')], {
  encoding: 'utf8',
  env: {
    ...process.env,
    CONARIUM_SUPABASE_URL: 'http://127.0.0.1:1',
    CONARIUM_SUPABASE_SERVICE_ROLE: 'x',
    CONARIUM_ANCHOR_TOKENS: tokensPath,
  },
})
const after = readFileSync(tokensPath, 'utf8')
const health2 = await request(app).get('/healthz')

console.log(`sync_exit=${sync.status} file_unchanged=${after === initial} health_before=${health.status} health_after=${health2.status}`)
console.log(`stderr_mentions_unchanged=${/unchanged/.test(sync.stderr)}`)
if (sync.status === 0 || after !== initial || health.status !== 200 || health2.status !== 200) {
  process.exit(1)
}
