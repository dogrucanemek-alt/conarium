import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const yml = readFileSync('.github/workflows/gacs.yml', 'utf8')
const uses = [...yml.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1])
assert.ok(uses.length >= 3, 'expected checkout, setup-node, upload-artifact')
for (const u of uses) {
  assert.match(u, /@[0-9a-f]{40}$/, `unpinned action: ${u}`)
}
console.log(`gacs ci pin: ${uses.length} actions SHA-pinned`)
