#!/usr/bin/env node
/**
 * Guards the unscoped launcher packages under wrappers/.
 *
 * Why they exist: `npx <name>` resolves a *package* name, never a bin name.
 * The README documents `npx conarium-verify`, but for a long time no package
 * by that name existed, so the command every third party was told to run
 * answered E404 — on the one path the product's central claim depends on
 * ("anyone can verify this receipt"). The launchers close that, and the names
 * are ours rather than a stranger's.
 *
 * What this check refuses to let rot:
 *   1. every command the README tells people to run has a launcher;
 *   2. each launcher's bin key equals its package name, or npx still misses;
 *   3. each launcher targets a bin that @conarium-ai/core actually ships;
 *   4. the exit code comes back unchanged — verified against a stub core that
 *      exits with a code we choose, so this holds without a build;
 *   5. the tarball allow-list stays an allow-list.
 *
 * (4) is the one that matters. Conarium answers with exit codes (0 intact,
 * 13 signature invalid, 14/15 anchor) and a launcher that normalised them
 * would report a tampered chain as clean while every test stayed green.
 *
 *   node test/wrapper_launchers.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wrappersDir = join(root, 'wrappers')
const core = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const fail = (msg) => failures.push(msg)

// Enough of caret semantics for this check, without pulling in a dependency:
// ^1.2.3 allows <2.0.0, ^0.2.3 allows <0.3.0, ^0.0.3 allows only 0.0.3.
function caretCovers(range, version) {
  if (!range.startsWith('^')) return range === version
  const [rMajor, rMinor, rPatch] = range.slice(1).split('.').map(Number)
  const [vMajor, vMinor, vPatch] = version.split('.').map(Number)
  if ([rMajor, rMinor, rPatch, vMajor, vMinor, vPatch].some(Number.isNaN)) return false
  if (vMajor !== rMajor) return false
  if (rMajor > 0) return vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch)
  if (vMinor !== rMinor) return false
  return rMinor > 0 ? vPatch >= rPatch : vPatch === rPatch
}

// ---------------------------------------------------------------- 1. coverage
// The line is every bin the core package publishes, not every bin the README
// happens to mention: the bin map ships inside the public tarball, so those
// names are readable by anyone, and an edit to the docs must not be able to
// move a name out of our control without this going red.
const present = new Set(
  readdirSync(wrappersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
)
for (const cmd of Object.keys(core.bin || {})) {
  if (!present.has(cmd)) {
    fail(`${core.name} ships a bin called "${cmd}" but wrappers/${cmd} does not exist — \`npx ${cmd}\` answers E404 and the name is free for anyone to take.`)
  }
}

// The other direction: docs pointing at a command the package does not ship.
const readme = readFileSync(join(root, 'README.md'), 'utf8')
for (const [, cmd] of readme.matchAll(/npx\s+(?:-p\s+\S+\s+)?(conarium[a-z-]*)/g)) {
  if (!(core.bin || {})[cmd]) {
    fail(`README documents \`npx ${cmd}\` but ${core.name} does not ship that bin.`)
  }
}

// -------------------------------------------- 2, 3, 5. per-package invariants
const coreBins = core.bin || {}
for (const name of present) {
  const pkgPath = join(wrappersDir, name, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`wrappers/${name}: no package.json`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  if (pkg.name !== name) {
    fail(`wrappers/${name}: package name is "${pkg.name}"; the directory and the published name must agree.`)
  }
  const binKeys = Object.keys(pkg.bin || {})
  if (binKeys.length !== 1 || binKeys[0] !== name) {
    fail(`wrappers/${name}: bin keys ${JSON.stringify(binKeys)} — npx resolves the package name, so the only bin must be "${name}".`)
  }
  if (!coreBins[name]) {
    fail(`wrappers/${name}: ${core.name} does not ship a bin called "${name}".`)
  }
  const dep = (pkg.dependencies || {})[core.name]
  if (!dep) {
    fail(`wrappers/${name}: does not depend on ${core.name}, so the command it forwards to is not installed.`)
  } else if (!caretCovers(dep, core.version)) {
    // A caret range on a 0.x version stops at the minor. Once core moves to
    // 0.3.0 every launcher silently keeps installing 0.2.x, and `npx` starts
    // handing people an old tool while every other check stays green.
    fail(`wrappers/${name}: depends on ${core.name}@${dep}, which does not cover the current ${core.version}. Re-run node wrappers/generate.mjs and republish.`)
  }
  const files = pkg.files || []
  if (!files.length || files.some((f) => f.startsWith('!'))) {
    fail(`wrappers/${name}: "files" must be an allow-list. This repo has already published a private key to npm once by listing directories.`)
  }
}

// ------------------------------------------------- 4. exit code is forwarded
// A stub core lets us assert forwarding for codes the real binary may never
// produce, and without needing dist/ to be built.
const EXPECTED = [0, 1, 2, 10, 13, 14, 15, 20, 42]
const probe = 'conarium-verify'

if (present.has(probe)) {
  const tmp = mkdtempSync(join(tmpdir(), 'conarium-wrapper-'))
  const fakeCore = join(tmp, 'node_modules', '@conarium-ai', 'core')
  mkdirSync(fakeCore, { recursive: true })
  writeFileSync(
    join(fakeCore, 'package.json'),
    JSON.stringify({ name: core.name, version: '0.0.0-stub', bin: { [probe]: 'stub.cjs' } })
  )
  writeFileSync(
    join(fakeCore, 'stub.cjs'),
    'process.exit(Number(process.env.CONARIUM_STUB_EXIT || 0))\n'
  )

  const launcher = join(tmp, 'wrappers', probe, 'bin')
  mkdirSync(launcher, { recursive: true })
  copyFileSync(join(wrappersDir, probe, 'bin', 'cli.cjs'), join(launcher, 'cli.cjs'))

  for (const code of EXPECTED) {
    const r = spawnSync(process.execPath, [join(launcher, 'cli.cjs')], {
      env: { ...process.env, CONARIUM_STUB_EXIT: String(code) },
      stdio: 'ignore',
    })
    if (r.status !== code) {
      fail(`wrappers/${probe}: core exited ${code}, launcher reported ${r.status} — the verification contract is the exit code.`)
    }
  }

  // A launcher that cannot find the core must say so and fail, not succeed.
  const orphan = mkdtempSync(join(tmpdir(), 'conarium-orphan-'))
  copyFileSync(join(wrappersDir, probe, 'bin', 'cli.cjs'), join(orphan, 'cli.cjs'))
  const r = spawnSync(process.execPath, [join(orphan, 'cli.cjs')], { stdio: 'pipe' })
  if (r.status === 0) {
    fail(`wrappers/${probe}: exits 0 when ${core.name} is missing — a run that never happened must not read as success.`)
  }
} else {
  fail(`wrappers/${probe} is missing; it is the launcher the public verification path depends on.`)
}

// ------------------------------------------------------------------- verdict
if (failures.length) {
  console.error('wrapper_launchers: FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(
  `wrapper_launchers: ok (${present.size} launchers covering ${Object.keys(core.bin || {}).length} core bins, ${EXPECTED.length} exit codes forwarded)`
)
