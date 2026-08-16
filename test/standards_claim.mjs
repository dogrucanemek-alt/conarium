/**
 * The Standards section must not read as IETF adoption.
 * An Internet-Draft is a dated public record. The Datatracker link stays;
 * the standing does not.
 */
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function section(md, heading) {
  const start = md.indexOf(`## ${heading}`)
  assert.ok(start >= 0, `missing ## ${heading}`)
  const after = md.slice(start + `## ${heading}`.length)
  const end = after.search(/\n## /)
  return (end < 0 ? after : after.slice(0, end)).trim()
}

const readme = readFileSync(join(root, 'README.md'), 'utf8')
const standards = section(readme, 'Standards')

assert.match(standards, /Individual submission/i, 'Standards must say individual submission')
assert.match(standards, /no formal standing/i, 'Standards must deny formal standing')
assert.match(standards, /not a standard/i, 'Standards must say an Internet-Draft is not a standard')
assert.match(standards, /implemented without us/i, 'Standards must say why it is published')

const overclaim = [
  /being standardi[sz]ed/i,
  /under discussion at the IETF/i,
  /IETF standard\b/i,
  /working group adopted/i,
  /on the IETF Datatracker\s*\.\s*$/m,
]
for (const re of overclaim) {
  assert.ok(!re.test(standards), `Standards overclaim: ${re}`)
}

const surfaces = [
  'standards/README.md',
  'docs.html',
  'public/index.html',
  'dpa.html',
  'terms.html',
  'privacy.html',
]
for (const rel of surfaces) {
  const p = join(root, rel)
  if (!existsSync(p)) continue
  const text = readFileSync(p, 'utf8')
  if (!/draft-dogru-scitt-disclosure-evidence|IETF Datatracker/i.test(text)) continue
  assert.match(text, /individual (submission|draft)/i, `${rel} mentions the draft without individual-submission standing`)
  assert.ok(!/being standardi[sz]ed/i.test(text), `${rel} implies IETF standardisation`)
}

console.log('standards claim: README + in-repo surfaces name individual submission, not a standard')
