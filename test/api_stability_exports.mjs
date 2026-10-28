#!/usr/bin/env node
/**
 * docs/API-STABILITY.md and package.json state the same fact: what the
 * package exports. The claims gate reads the document only when the document
 * changes, so when package.json gained an "exports" map the document went on
 * saying there was none and nothing turned red. This check compares the two:
 *
 *   1. every key of package.json "exports" is named in the document's
 *      "## Package exports" section
 *   2. the document does not say the map is absent while package.json has one
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const doc = readFileSync(join(root, 'docs', 'API-STABILITY.md'), 'utf8')

const start = doc.indexOf('## Package exports')
assert.ok(start >= 0, 'docs/API-STABILITY.md has no "## Package exports" section')
const next = doc.indexOf('\n## ', start + 1)
const section = doc.slice(start, next < 0 ? undefined : next)

const keys = Object.keys(pkg.exports ?? {})
const problems = []
for (const key of keys) {
  if (!section.includes(`exports["${key}"]`)) problems.push(`exports["${key}"] is in package.json but not in the Package exports table`)
}
if (keys.length > 0) {
  if (/There is no `exports` map/.test(doc)) problems.push('the document says "There is no `exports` map"')
  if (/`exports` field \| \*\*absent\*\*/.test(section)) problems.push('the Package exports table says the field is absent')
}

if (problems.length) {
  console.log('FAIL api_stability_exports\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log(`ok   api_stability_exports (${keys.length} export keys named)`)
