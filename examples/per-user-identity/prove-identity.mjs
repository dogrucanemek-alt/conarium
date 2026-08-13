#!/usr/bin/env node
/**
 * Local proof: same row, two tokens, two receipts.
 * Does not talk to Hetzner. Needs a built dist/ (npm run build).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const distGov = join(root, 'dist', 'governance.js')
const distAudit = join(root, 'dist', 'audit.js')
const distTokens = join(root, 'dist', 'tokens.js')
const distKeys = join(root, 'dist', 'keys.js')
const verifyJs = join(root, 'bin', 'conarium-verify.mjs')

function fail(msg) {
  console.error(`FAIL  ${msg}`)
  process.exit(1)
}

const { Governance } = await import(pathToFileURL(distGov).href)
const { Audit } = await import(pathToFileURL(distAudit).href)
const { loadTokenStore, resolveActor } = await import(pathToFileURL(distTokens).href)
const { writeKeyPairFiles } = await import(pathToFileURL(distKeys).href)

const dir = mkdtempSync(join(tmpdir(), 'cnr-identity-'))
const tokensFile = join(dir, 'conarium.tokens.json')
const receiptSink = join(dir, 'receipts.jsonl')
const auditSink = join(dir, 'audit.jsonl')
mkdirSync(dir, { recursive: true })

const patronRaw = randomBytes(32).toString('base64url')
const aiRaw = randomBytes(32).toString('base64url')
writeFileSync(tokensFile, JSON.stringify({
  tokens: [
    { sha256: createHash('sha256').update(patronRaw).digest('hex'), id: 'emekcan' },
    { sha256: createHash('sha256').update(aiRaw).digest('hex'), id: 'copilot' },
  ],
}) + '\n')

const keyFiles = writeKeyPairFiles(join(dir, 'audit-ed25519'), 'cnr-identity-demo')
process.env.CONARIUM_AUDIT_SIGNING_KEY = keyFiles.privatePath
process.env.CONARIUM_AUDIT_TRUST_PUBKEYS = keyFiles.publicPath
delete process.env.CONARIUM_AUDIT_UNSIGNED

const policy = {
  allowTables: ['public.customers'],
  maskColumns: ['*.customer_name', '*.email', '*.phone', '*.tckn', '*.iban'],
  profiles: {
    patron: {
      maskColumns: ['*.email', '*.phone', '*.tckn', '*.iban'],
      maskLabelledNames: false,
    },
  },
  actorProfiles: { emekcan: 'patron' },
}

const store = loadTokenStore(tokensFile)
const patron = resolveActor(patronRaw, store, 'conarium_c2')
const ai = resolveActor(aiRaw, store, 'conarium_c2')
if (patron.assurance !== 'per-user-token' || patron.id !== 'emekcan') fail(`patron resolve: ${JSON.stringify(patron)}`)
if (ai.assurance !== 'per-user-token' || ai.id !== 'copilot') fail(`ai resolve: ${JSON.stringify(ai)}`)

const row = { _table: 'public.customers', customer_name: 'Ayşe Yılmaz', email: 'a@b.com', city: 'İzmir' }
const base = new Governance(policy)
const asPatron = base.forActor(patron)
const asAi = base.forActor(ai)

const patronOut = asPatron.redact({ rows: [row], rowCount: 1, fields: Object.keys(row) })
const aiOut = asAi.redact({ rows: [row], rowCount: 1, fields: Object.keys(row) })
const pName = patronOut.rows[0].customer_name
const aName = aiOut.rows[0].customer_name

console.log(`patron name  ${pName}`)
console.log(`ai name      ${aName}`)
console.log(`patron email ${patronOut.rows[0].email}`)
console.log(`ai email     ${aiOut.rows[0].email}`)

if (pName !== 'Ayşe Yılmaz') fail(`patron should see the name, got ${pName}`)
if (aName !== '[MASKED_PII]') fail(`ai should see [MASKED_PII], got ${aName}`)
if (patronOut.rows[0].email !== '[MASKED_PII]' || aiOut.rows[0].email !== '[MASKED_PII]') {
  fail('email must stay masked for both (content scanner / remaining maskColumns)')
}

const audit = new Audit({ sink: auditSink, receiptSink, consumer: 'conarium_c2', failClosed: true })
audit.log({
  tool: 'query',
  target: 'public.customers',
  denied: false,
  actor: patron.id,
  actorAssurance: patron.assurance,
  policyProfile: asPatron.appliedProfile() || undefined,
  rowsReturned: 1,
  source: 'postgres',
})
audit.log({
  tool: 'query',
  target: 'public.customers',
  denied: false,
  actor: ai.id,
  actorAssurance: ai.assurance,
  policyProfile: asAi.appliedProfile() || undefined,
  rowsReturned: 1,
  source: 'postgres',
})

const receipts = readFileSync(receiptSink, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
if (receipts.length !== 2) fail(`expected 2 receipts, got ${receipts.length}`)

const [rPatron, rAi] = receipts
console.log(`patron policy.id   ${rPatron.policy.id}`)
console.log(`patron assurance   ${rPatron.actor.assurance}  actor.id=${rPatron.actor.id}`)
console.log(`ai policy.id       ${rAi.policy.id}`)
console.log(`ai assurance       ${rAi.actor.assurance}  actor.id=${rAi.actor.id}`)

if (rPatron.policy.id !== 'conarium.policy/patron') fail(`patron policy.id ${rPatron.policy.id}`)
if (rAi.policy.id !== 'conarium.policy') fail(`ai (no profile) policy.id ${rAi.policy.id}`)
if (rPatron.actor.assurance !== 'per-user-token' || rAi.actor.assurance !== 'per-user-token') {
  fail('both receipts must carry per-user-token')
}

const v = spawnSync(process.execPath, [verifyJs, receiptSink, '--pubkey', keyFiles.publicPath], {
  encoding: 'utf8',
  env: process.env,
})
process.stdout.write(v.stdout || '')
process.stderr.write(v.stderr || '')
if (v.status !== 0) fail(`conarium-verify exit ${v.status}`)
if (!String(v.stdout || v.stderr || '').includes('verified')) fail('verify output missing verified')

console.log('PASS  same query, two tokens, two receipts, verify EXIT 0')
console.log(`artefacts in ${dir} (temp; not Hetzner)`)
process.exit(0)
