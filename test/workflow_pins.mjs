#!/usr/bin/env node
/**
 * Every third-party thing CI executes is named by digest, not by a moving tag.
 *
 * There was already a check for this. It read one file — `.github/workflows/
 * gacs.yml` — because that is the file that was in front of whoever wrote it,
 * and the filename was written into the check by hand. It stayed green while
 * five action references and three base images in the other seven files went on
 * pointing at tags. OpenSSF Scorecard found them, from outside, weeks later.
 *
 * That is the failure mode this repository keeps meeting: a guard scoped to the
 * example that prompted it, so the class it belongs to grows behind its back. So
 * this one takes no file list. It walks the workflow directory and the
 * Dockerfiles that exist, and whatever is there is what it checks. A new
 * workflow is covered on the commit that adds it, with nobody remembering to
 * come back here.
 *
 * What it does not do: judge whether a pinned digest is current. A pin nobody
 * advances is a frozen set of CVEs, which is a different problem with a
 * different mechanism — .github/dependabot.yml watches the github-actions and
 * docker ecosystems and opens the bump as a pull request. This check would be
 * green on a two-year-old digest, and says so rather than implying otherwise.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /@sha256:[0-9a-f]{64}\b/

/** `uses:` references that are not a third-party action pull. */
const isLocal = (ref) => ref.startsWith('./') || ref.startsWith('.\\')

export function unpinnedActions(text) {
  const bad = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)
    if (!m) continue
    const ref = m[1].replace(/^['"]|['"]$/g, '')
    if (isLocal(ref)) continue
    const at = ref.lastIndexOf('@')
    if (at === -1) {
      bad.push({ ref, why: 'no version at all' })
      continue
    }
    if (!SHA.test(ref.slice(at + 1))) bad.push({ ref, why: 'tag, not a commit SHA' })
  }
  return bad
}

export function unpinnedImages(text) {
  const stages = new Set()
  const bad = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (!m) continue
    const [, image, alias] = m
    if (alias) stages.add(alias.toLowerCase())
    // `FROM build` refers to an earlier stage in this same file; there is no
    // registry lookup to pin.
    if (stages.has(image.toLowerCase()) || image.toLowerCase() === 'scratch') continue
    if (!DIGEST.test(image)) bad.push({ ref: image, why: 'tag, not a digest' })
  }
  return bad
}

// ── the red path, proven on every run ────────────────────────────────────────

assert.equal(unpinnedActions('      - uses: actions/checkout@v4\n').length, 1, 'a tag must be red')
assert.equal(
  unpinnedActions('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n')
    .length,
  0,
  'a SHA-pinned action must be green',
)
assert.equal(
  unpinnedActions('      - uses: ./.github/workflows/reusable.yml\n').length,
  0,
  'a local workflow reference has nothing to pin',
)
assert.equal(unpinnedImages('FROM node:20-slim AS build\n').length, 1, 'a tagged image must be red')
assert.equal(
  unpinnedImages(
    'FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build\nFROM build AS runtime\n',
  ).length,
  0,
  'a digest-pinned image, and a stage referring back to it, must be green',
)

// ── the tree, discovered rather than listed ──────────────────────────────────

const workflowDir = join(root, '.github', 'workflows')
const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => join(workflowDir, f))
  : []
assert.ok(workflows.length > 0, 'no workflows found — has the directory moved?')

/** Dockerfiles anywhere in the tree, skipping dependencies and build output. */
function dockerfiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) dockerfiles(path, found)
    else if (/^Dockerfile(\..+)?$/.test(entry.name)) found.push(path)
  }
  return found
}

const images = dockerfiles(root)
assert.ok(images.length > 0, 'no Dockerfile found — has the image moved?')

const problems = []
let actionRefs = 0
for (const file of workflows) {
  const text = readFileSync(file, 'utf8')
  actionRefs += (text.match(/^\s*(?:-\s*)?uses:/gm) || []).length
  for (const b of unpinnedActions(text)) {
    problems.push(`${relative(root, file).replace(/\\/g, '/')}: ${b.ref} — ${b.why}`)
  }
}
let imageRefs = 0
for (const file of images) {
  const text = readFileSync(file, 'utf8')
  imageRefs += (text.match(/^\s*FROM\s/gim) || []).length
  for (const b of unpinnedImages(text)) {
    problems.push(`${relative(root, file).replace(/\\/g, '/')}: ${b.ref} — ${b.why}`)
  }
}

if (problems.length) {
  console.error(`unpinned CI dependencies (${problems.length}):`)
  for (const p of problems) console.error(`    ${p}`)
  console.error('')
  console.error('  A tag can be moved onto other code after it was reviewed. Pin the commit')
  console.error('  SHA for actions and the sha256 digest for images, and let dependabot')
  console.error('  advance them where the bump can be read.')
  process.exit(1)
}

console.log(
  `workflow pins GREEN — ${actionRefs} action reference(s) across ${workflows.length} workflow(s) ` +
    `and ${imageRefs} FROM line(s) across ${images.length} Dockerfile(s), all pinned by digest`,
)
