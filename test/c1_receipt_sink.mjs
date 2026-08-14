/**
 * c1 receipt sink never formed because the launcher did not set the signing key.
 * This pins the fix. It must not create an empty receipts-c1.jsonl.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'scripts', 'start-mcp-c1.mjs'), 'utf8')

assert.match(src, /CONARIUM_AUDIT_SIGNING_KEY/)
assert.match(src, /audit-ed25519\.pem/)
assert.match(src, /receiptSink/)
assert.match(src, /first governed access/)
assert.doesNotMatch(src, /writeFileSync\([^)]*receipts-c1/)
assert.doesNotMatch(src, /writeFileSync\([^)]*receiptSink/)

const sink = join(homedir(), '.conarium', 'receipts-c1.jsonl')
if (existsSync(sink)) {
  const body = readFileSync(sink, 'utf8').trim()
  assert.ok(body.length > 0, 'sink exists but is empty — launcher must not invent a blank file')
}

console.log('PASS  ::  c1 launcher sets the signing key; does not invent an empty sink')
process.exit(0)
