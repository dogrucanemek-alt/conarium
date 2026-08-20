#!/usr/bin/env node
/**
 * The version in package.json is a claim about what is on npm. Check it.
 *
 * 0.2.21 was published, then makbuz 0.4 and two Go fixes landed on the same
 * version number. For most of a day `npm i @conarium-ai/core@0.2.21` and the
 * repository at 0.2.21 were different software, and nothing said so — the number
 * was hand-written, so it could not disagree with itself.
 *
 * It happened again within hours: 0.2.23 shipped, then README, SECURITY and
 * LIMITATIONS were corrected on the same version, so the published package
 * carried claims the repository had already retracted.
 *
 * This check asks one question: if a release tag exists for the version in
 * package.json, does any file npm would ship differ from that tag? The file list
 * comes from `npm pack --dry-run`, not from a copy of the `files` array here — a
 * second copy of that list would be one more hand-written claim to drift.
 *
 * Going red means the version number is lying, and the fix is to bump it. It is
 * not a reason to widen the exemption list.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/**
 * `npm` is a .cmd shim on Windows, and since the CVE-2024-27980 fix Node refuses
 * to spawn one without a shell. The shell is enabled only here and only for a
 * fixed argument list written in this file — nothing from the repository, the
 * environment or a filename reaches it.
 */
function npmPackFileList() {
  const out = execFileSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
  })
  const entry = Object.values(JSON.parse(out))[0]
  assert.ok(entry?.files?.length, 'npm pack --dry-run returned no file list')
  return entry.files.map((f) => f.path.replace(/\\/g, '/'))
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
const tag = `v${version}`

// ── the same number, declared a second time ──────────────────────────────────
//
// server.json carries the version twice for the MCP registry, and both were
// hand-maintained. Releasing 0.2.25 on 2026-08-17 published to npm and then
// failed at the registry with "cannot publish duplicate version", because
// server.json still said 0.2.24 — the registry was being offered a number it
// already had. The release step that writes the git tag ran after the registry
// step, so it was skipped too: npm had the release, the repository had no tag
// for it. Two declarations of one fact, neither derived from the other.

const serverPath = join(root, 'server.json')
if (existsSync(serverPath)) {
  const raw = readFileSync(serverPath, 'utf-8')
  const server = JSON.parse(raw)
  const declared = [
    ['version', server.version],
    ...(server.packages ?? []).map((p, i) => [`packages[${i}].version`, p.version]),
  ]
  const wrong = declared.filter(([, v]) => v !== version)
  assert.equal(
    wrong.length,
    0,
    `server.json disagrees with package.json (${version}):\n` +
      wrong.map(([where, v]) => `  ${where} = ${v}`).join('\n') +
      '\n\nThe MCP registry rejects a version it already holds, and it reads server.json.\n',
  )
}

function originHasTag(tagName) {
  const out = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!out) return false
  return out.split('\n').some((line) => {
    const ref = line.split(/[\t ]/).pop()
    return ref === `refs/tags/${tagName}` || ref === `refs/tags/${tagName}^{}`
  })
}

let taggedOnOrigin
try {
  taggedOnOrigin = originHasTag(tag)
} catch {
  // Asking the remote is the question. If the network is down, we did not
  // answer it — print SKIP rather than look like a pass.
  console.log(`SKIP version claim: origin unreachable — cannot ask whether ${tag} exists`)
  process.exit(0)
}

if (!taggedOnOrigin) {
  // Nothing has been published under this number, so the number contradicts
  // nothing. This is the normal state while a release is being prepared.
  console.log(`version claim: ${version} is not tagged on origin — nothing published to contradict`)
  process.exit(0)
}

let taggedLocally = true
try {
  run('git', ['rev-parse', '--verify', `refs/tags/${tag}`])
} catch {
  taggedLocally = false
}

assert.ok(
  taggedLocally,
  `origin has ${tag}, but this clone does not.\n` +
    `  A missing local tag used to look like an unpublished version.\n` +
    `  Fetch the tag before asking whether ${version} still matches what was shipped.\n`,
)

// What npm would actually ship, asked of npm rather than restated here.
const shipped = new Set(npmPackFileList())

// package.json itself always differs on a version bump; it is the bump.
shipped.delete('package.json')

const changed = run('git', ['diff', '--name-only', `${tag}..HEAD`])
  .split('\n')
  .map((p) => p.trim().replace(/\\/g, '/'))
  .filter(Boolean)
  .filter((p) => shipped.has(p))

assert.equal(
  changed.length,
  0,
  `package.json says ${version}, and ${tag} is published, but ${changed.length} file(s) npm ships ` +
    `have changed since that tag:\n` +
    changed.map((p) => `    ${p}`).join('\n') +
    `\n\n  Anyone installing ${version} gets the published copy of those files, not these.\n` +
    `  Bump the version. Do not exempt the files.\n`,
)

console.log(
  `version claim: ${version} is tagged and every one of the ${shipped.size} files npm ships matches ${tag}`,
)
