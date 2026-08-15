/**
 * The suite must be runnable by a second implementation. If anything under
 * conformance/ imports this repo's modules, the suite is just us testing us.
 */
import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = join('conformance')
const FORBIDDEN = [
  /from\s+['"][^'"]*\/src\//,
  /from\s+['"]@conarium-ai\//,
  /from\s+['"][^'"]*\/dist\//,
  /new\s+Governance\b/,
  /require\(\s*['"][^'"]*\/src\//,
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(mjs|js|cjs|ts)$/.test(extname(p))) acc.push(p)
  }
  return acc
}

const files = walk(ROOT)
assert.ok(files.length > 0, 'conformance/ has no JS files')
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(text), `${file} imports an implementation module (${re})`)
  }
}
console.log(`gacs import fence: ${files.length} file(s) clean`)
