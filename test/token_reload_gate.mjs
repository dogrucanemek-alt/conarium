#!/usr/bin/env node
/**
 * Mint-shaped file → service 201; revoke-shaped file → 401.
 * Raw token is never printed.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey } from 'node:crypto'
import { createAnchorService, loadTokensFile, readTokensSnapshot } from '../dist/anchor-service.js'
import { generateKeyPair } from '../dist/keys.js'

const dir = mkdtempSync(join(tmpdir(), 'conarium-reload-'))
const tokensPath = join(dir, 'tokens.json')
const raw = 'gate-token-please-do-not-log-this-value'
const sha = createHash('sha256').update(raw).digest('hex')
writeFileSync(
  tokensPath,
  JSON.stringify({ _conarium_sync: 't0', [`sha256:${sha}`]: 'buyer@example.com' }),
)

const pair = generateKeyPair('gate-reload-key')
let live = loadTokensFile(tokensPath)
const { app } = createAnchorService({
  storePath: join(dir, 'store.jsonl'),
  tokens: live,
  getTokens: () => live,
  publicBaseUrl: 'https://anchor.example',
  signingKey: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) },
  stamp: async () => Buffer.from('ots').toString('base64'),
  upgrade: async () => ({ upgraded: false }),
})

const server = createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

async function hit() {
  const res = await fetch(`http://127.0.0.1:${port}/anchor`, {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hash: 'sha256:' + 'ab'.repeat(32) }),
  })
  return res.status
}

const first = await hit()
writeFileSync(tokensPath, JSON.stringify({ _conarium_sync: 't1' }))
const snap = readTokensSnapshot(tokensPath)
if (!snap.authoritative || snap.tokens.size !== 0) {
  console.error('revoke file was not authoritative empty')
  process.exit(1)
}
live = snap.tokens
const second = await hit()
server.close()

console.log(`mint_sync_status=${first} revoke_sync_status=${second} token=[redacted]`)
if (first !== 201 || second !== 401) process.exit(1)
