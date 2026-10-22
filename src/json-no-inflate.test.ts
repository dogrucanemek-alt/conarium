import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrivateKey } from 'crypto'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { brotliCompressSync, gzipSync } from 'zlib'
import request from 'supertest'
import { createAnchorService } from './anchor-service.js'
import { createConsoleApp } from './console.js'
import { generateKeyPair } from './keys.js'

// A compressed request body is decoded before any route or token check runs.
// The JSON parsers refuse it instead, so a decoder bug is not reachable by an
// anonymous caller.
const BODY = JSON.stringify({ hash: 'sha256:' + 'ab'.repeat(32) })

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => {
  process.env.CONARIUM_AUDIT_UNSIGNED = '1'
})
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

function anchorApp() {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-inflate-'))
  const pair = generateKeyPair('test-anchor-key')
  return createAnchorService({
    storePath: join(dir, 'anchors.jsonl'),
    tokens: new Map([['tok-a', 'acme']]),
    publicBaseUrl: 'https://anchor.example/',
    signingKey: { keyId: pair.keyId, privateKey: createPrivateKey(pair.privatePem) },
    stamp: async () => 'x',
    upgrade: async () => ({ upgraded: false }),
  }).app
}

function consoleApp() {
  const dir = mkdtempSync(join(tmpdir(), 'console-inflate-'))
  return createConsoleApp({ configFile: join(dir, 'conarium.config.json'), auditFile: join(dir, 'audit.jsonl') })
}

describe('json bodies are not inflated', () => {
  for (const [name, make] of [['anchor service', anchorApp], ['console', consoleApp]] as const) {
    for (const [encoding, encode] of [['br', brotliCompressSync], ['gzip', gzipSync]] as const) {
      it(`${name} refuses a ${encoding} body before auth`, async () => {
        const res = await request(make())
          .post('/anchor')
          .set('content-type', 'application/json')
          .set('content-encoding', encoding)
          .send(encode(Buffer.from(BODY)))
        expect(res.status).toBe(415)
      })
    }

    it(`${name} still reads an identity body`, async () => {
      const res = await request(make()).post('/anchor').set('content-type', 'application/json').send(BODY)
      expect(res.status).not.toBe(415)
    })
  }
})
