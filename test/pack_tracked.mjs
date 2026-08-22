#!/usr/bin/env node
/**
 * Every file npm ships is either in the repository or a declared build output.
 *
 * `.gitignore` does not bind npm. The `files` allow-list in package.json is
 * evaluated against the working directory, so anything sitting on the packer's
 * disk under an allowed path is packed — tracked or not, ignored or not. That
 * sentence is already in package.json, written after `npm publish` on a machine
 * that had run the demo shipped `examples/_keys/audit-ed25519.pem`, a private
 * key. `test/pack_artefakt.mjs` locks that one path. Nothing locks the class.
 *
 * The class bit again on 2026-08-22, without a key this time. `pack_locale`
 * reported 324 Turkish lines across 22 packed doc files. Run at v0.2.42 in a
 * clean worktree the same guard reports 310 across 20. The difference is two
 * files under `docs/audit/` that are gitignored, present on one machine, and in
 * no release: 310 + 14 = 324, 20 + 2 = 22, reproduced by copying them in. The
 * figure reached a changelog and then a public mailing list, where nobody can
 * reproduce it, because it was never a fact about the package.
 *
 * So the rule is not about keys or about Turkish. A package built from a dirty
 * tree is a different package, and every measurement taken over it is a
 * measurement of somebody's disk.
 *
 * Green means: what npm would ship here is what CI would ship from a clean
 * checkout. It does not mean the contents are correct — `pack_artefakt`,
 * `pack_locale` and `pack_path_refs` ask that, and they are only worth reading
 * when this one passes, because they all measure the same working directory.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Paths npm ships that git is right not to track. One entry, and it should
 * stay that way: a second entry means a second thing whose contents no commit
 * records. `dist/` is reproducible from `src/` by `npm run build`, which is
 * what makes it safe to ship unrecorded.
 */
const GENERATED = ['dist/']

function sh(cmd) {
  return execFileSync(cmd, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    maxBuffer: 1024 * 1024 * 64,
  })
}

function packedFiles() {
  const parsed = JSON.parse(sh('npm pack --dry-run --json').trim())
  const listing = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  if (!listing?.files?.length) throw new Error('npm pack --dry-run returned no file list')
  return listing.files.map((f) => f.path.split(String.fromCharCode(92)).join('/'))
}

/**
 * Fail closed. If git cannot answer, this check has established nothing, and a
 * check that cannot run must not report the same word as a check that ran and
 * found the tree clean.
 */
let tracked
try {
  tracked = new Set(sh('git ls-files').split('\n').filter(Boolean))
  if (!tracked.size) throw new Error('git ls-files returned nothing')
} catch (err) {
  console.error(`pack tracked RED — could not ask git what is tracked: ${err.message}`)
  console.error('  This check refuses to pass without an answer. It is not a style check.')
  process.exit(1)
}

const packed = packedFiles()
const generated = []
const strays = []
for (const rel of packed) {
  if (tracked.has(rel)) continue
  if (GENERATED.some((p) => rel.startsWith(p))) {
    generated.push(rel)
    continue
  }
  strays.push(rel)
}

if (strays.length) {
  console.error(
    `pack tracked RED — ${strays.length} file(s) would ship that this repository does not contain:\n  ` +
      strays.join('\n  '),
  )
  console.error(
    '\n  They exist in this working directory and in no commit, so a release built here\n' +
      '  differs from one built by CI, and every figure measured over this package is a\n' +
      '  figure about this machine. Commit them, delete them, or exclude the path in the\n' +
      '  "files" list in package.json — .gitignore does not reach npm.',
  )
  process.exit(1)
}

console.log(
  `pack tracked GREEN — ${packed.length} packed path(s): ${packed.length - generated.length} tracked, ` +
    `${generated.length} generated under ${GENERATED.join(', ')}; nothing else`,
)
