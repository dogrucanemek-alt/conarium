#!/usr/bin/env node
/**
 * gen-test-vectors — build the frozen conformance vectors under test-vectors/.
 *
 * Run ONCE to create the vectors, then leave them alone. They are a contract:
 * if a change to this repo makes them fail, the format changed, and that is
 * exactly what the vectors exist to surface. Regenerating them to make a red
 * test go green defeats their entire purpose.
 *
 * Everything here is deterministic — fixed key, fixed ids, fixed timestamps —
 * so a second implementation can reproduce byte-identical output.
 *
 * Usage: npm run build && node scripts/gen-test-vectors.mjs
 *
 * 001–009 are frozen. If they already exist, this script refuses to run —
 * regenerating them would rewrite published 0.3 receipts. New 0.4 cases
 * are produced by scripts/gen-test-vectors-04.mjs.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createPrivateKey } from 'crypto'
import { generateKeyPair } from '../dist/keys.js'
import { buildReceipt, RECEIPT_GENESIS_HASH } from '../dist/receipt.js'

const ROOT = 'test-vectors'
if (existsSync(join(ROOT, '001-single-receipt', 'receipts.jsonl'))) {
  console.error('001–009 are frozen. Refusing to regenerate. For 0.4 cases: node scripts/gen-test-vectors-04.mjs')
  process.exit(2)
}
const KEY_DIR = join(ROOT, 'keys')
const KEY_ID = 'cnr-vectors'
const PRIV = join(KEY_DIR, 'vector-key.SECRET-TEST-ONLY.pem')
const PUB = join(KEY_DIR, 'vector-key.pub.pem')

mkdirSync(KEY_DIR, { recursive: true })

// The key is generated once and then frozen. Ed25519 signing is deterministic
// (RFC 8032), so the same key over the same hash always yields the same
// signature — which is what lets a second implementation check its producer,
// not just its verifier.
if (!existsSync(PRIV)) {
  const kp = generateKeyPair(KEY_ID)
  writeFileSync(
    PRIV,
    '# TEST VECTOR KEY — PUBLISHED ON PURPOSE, NEVER USE FOR ANYTHING REAL.\n' +
      '# Anyone reading this repository has the private half. It signs nothing\n' +
      '# but the frozen vectors in this directory.\n' +
      kp.privatePem,
  )
  writeFileSync(PUB, kp.publicPem)
  writeFileSync(PUB + '.keyid', KEY_ID + '\n')
  console.log(`generated frozen vector key: ${PRIV}`)
}

const privatePem = readFileSync(PRIV, 'utf-8').replace(/^#[^\n]*\n/gm, '')
const key = { keyId: KEY_ID, privateKey: createPrivateKey(privatePem) }

/** A receipt body with every field pinned — no clock, no randomness. */
function input(n, overrides = {}) {
  return {
    id: `01JVECTOR00000000000000${String(n).padStart(3, '0')}`,
    ts: `2026-01-0${n}T00:00:00.000Z`,
    period: { start: `2026-01-0${n}T00:00:00.000Z`, end: `2026-01-0${n}T00:00:01.000Z` },
    actor: { id: 'vector-service', type: 'service', assurance: 'shared-token' },
    request: { tool: 'query', argsHash: `sha256:${'ab'.repeat(32)}` },
    dataRefs: [{ source: 'vectors', object: 'public.demo', fields: ['id', 'name'] }],
    policy: { id: 'conarium.policy/vectors', decision: 'allow', rules: ['mask:name'] },
    flags: [],
    masking: { pii: 1 },
    outcome: { status: 'complete', rows: 2 },
    ...overrides,
  }
}

const cases = []
function emit(name, description, files, expect) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content)
  }
  cases.push({ name, description, ...expect })
  console.log(`  ${name} -> exit ${expect.exitCode}`)
}

const line = (r) => JSON.stringify(r) + '\n'

// --- 001: one valid receipt ------------------------------------------------
const r1 = buildReceipt(input(1), { seq: 1, prevHash: RECEIPT_GENESIS_HASH }, key)
emit('001-single-receipt', 'One valid signed receipt. The smallest passing case.', {
  'receipts.jsonl': line(r1),
}, { exitCode: 0, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 002: a chain of three -------------------------------------------------
const r2 = buildReceipt(input(2), { seq: 2, prevHash: r1.chain.hash }, key)
const r3 = buildReceipt(input(3), { seq: 3, prevHash: r2.chain.hash }, key)
emit('002-chain-of-three', 'Three receipts linked by prevHash. Contiguous, all signed.', {
  'receipts.jsonl': line(r1) + line(r2) + line(r3),
}, { exitCode: 0, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 003: a field was edited after signing --------------------------------
const tampered = JSON.parse(JSON.stringify(r1))
tampered.outcome.rows = 999
emit('003-tampered-field', 'outcome.rows changed from 2 to 999 after signing. The stored hash no longer matches the body.', {
  'receipts.jsonl': line(tampered),
}, { exitCode: 10, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 004: a receipt was removed from the middle ---------------------------
emit('004-prevhash-break', 'The middle receipt of the chain was deleted. #3 points at a hash that is no longer present.', {
  'receipts.jsonl': line(r1) + line(r3),
}, { exitCode: 11, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 005: sequence numbers jump -------------------------------------------
const gap = buildReceipt(input(4), { seq: 7, prevHash: r1.chain.hash }, key)
emit('005-seq-gap', 'seq jumps 1 -> 7. prevHash still links, so only the counter reveals the gap.', {
  'receipts.jsonl': line(r1) + line(gap),
}, { exitCode: 12, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 006: signature does not verify ---------------------------------------
const badSig = JSON.parse(JSON.stringify(r1))
badSig.sig.value = Buffer.from(Buffer.from(badSig.sig.value, 'base64').map((b, i) => (i === 0 ? b ^ 0xff : b))).toString('base64')
emit('006-bad-signature', 'First byte of the signature flipped. Body and hash are untouched — only the signature is wrong.', {
  'receipts.jsonl': line(badSig),
}, { exitCode: 13, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 007: not a receipt at all --------------------------------------------
const broken = JSON.parse(JSON.stringify(r1))
delete broken.policy
emit('007-schema-invalid', 'policy removed. The verifier must reject the shape before it trusts anything else in the file.', {
  'receipts.jsonl': line(broken),
}, { exitCode: 20, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- 008: unsigned, no key offered ----------------------------------------
// Producing an unsigned receipt is refused unless the operator says so out loud.
// That refusal is itself part of the format's contract, so it is exercised here.
process.env.CONARIUM_AUDIT_UNSIGNED = '1'
const unsigned = buildReceipt(input(5), { seq: 1, prevHash: RECEIPT_GENESIS_HASH }, null)
delete process.env.CONARIUM_AUDIT_UNSIGNED
// Written expecting 0 — the verifier said 13, and the verifier was right.
// There is no mode in which it reports success without checking a signature,
// even when the caller never asked for one. Frozen here so that property can
// never be quietly relaxed.
emit('008-unsigned-no-pubkey', 'An unsigned receipt, verified without --pubkey. Hash and chain are intact, yet the answer is still 13: the verifier never reports success on a signature it did not check.', {
  'receipts.jsonl': line(unsigned),
}, { exitCode: 13, args: [] })

// --- 009: signature demanded but absent -----------------------------------
emit('009-unsigned-but-pubkey-given', 'The same unsigned receipt, but the caller asked for signature verification. Fail-closed: a missing signature is not a passing signature.', {
  'receipts.jsonl': line(unsigned),
}, { exitCode: 13, args: ['--pubkey', 'KEYS/vector-key.pub.pem'] })

// --- canonical hashes ------------------------------------------------------
// The private key is NOT published (see test-vectors/README.md), so a second
// implementation cannot byte-compare signatures against ours. It does not need
// to: signing is RFC 8032 and well covered elsewhere. The part that is ours —
// and the part that silently breaks — is JCS canonicalisation and the hash
// derived from it. These are the numbers to match.
writeFileSync(
  join(ROOT, 'expected-hashes.json'),
  JSON.stringify(
    {
      note: 'Canonicalise the receipt with JCS (RFC 8785) excluding chain.hash, sig and anchor, then SHA-256. If your hash matches, your canonical form matches byte for byte.',
      genesisPrevHash: RECEIPT_GENESIS_HASH,
      receipts: [
        { case: '001-single-receipt', seq: 1, prevHash: r1.chain.prevHash, hash: r1.chain.hash },
        { case: '002-chain-of-three', seq: 2, prevHash: r2.chain.prevHash, hash: r2.chain.hash },
        { case: '002-chain-of-three', seq: 3, prevHash: r3.chain.prevHash, hash: r3.chain.hash },
      ],
    },
    null,
    2,
  ) + '\n',
)

// --- manifest --------------------------------------------------------------
writeFileSync(
  join(ROOT, 'manifest.json'),
  JSON.stringify(
    {
      format: 'conarium-receipt',
      versionUnderTest: r1.v,
      keyId: KEY_ID,
      publicKey: 'keys/vector-key.pub.pem',
      note: 'Frozen conformance vectors. Run each case through your verifier and compare the exit code. KEYS/ in args resolves to the keys/ directory at the root of test-vectors.',
      exitCodes: {
        0: 'chain intact, signatures valid',
        2: 'Usage error — no receipt was read',
        10: 'hash mismatch — record altered',
        11: 'prevHash break — deleted or inserted',
        12: 'seq gap / non-increasing',
        13: 'signature invalid or missing while a pubkey was supplied',
        20: 'schema invalid',
      },
      cases,
    },
    null,
    2,
  ) + '\n',
)

console.log(`\n${cases.length} cases written to ${ROOT}/`)
console.log(`chain hashes: ${r1.chain.hash} -> ${r2.chain.hash} -> ${r3.chain.hash}`)
