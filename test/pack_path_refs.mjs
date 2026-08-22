#!/usr/bin/env node
/**
 * A shipped document must not point at a file the package does not ship.
 *
 * `docs/RECEIPT-SPEC.md` opened with "Design source:
 * `docs/superpowers/specs/2026-07-29-conarium-receipt-design.md`" — true in the
 * repository, and a dead end for everyone who arrived through `npm i`. It only
 * became one when that directory was dropped from the package, which is the
 * point: the reference was written when the path shipped, and nothing was
 * watching the day it stopped.
 *
 * The list of what ships is not going to stop changing, so the check is not a
 * list of forbidden paths. It asks npm what it packs, reads the documents in
 * that answer, and fails when one of them names a repository path that exists
 * here and is missing there. A path that exists in neither is left alone —
 * historical notes are full of files that were deleted years ago, and a check
 * that cries wolf on those gets switched off.
 *
 * ⚠️ It only looks at directories the package **partially** ships. The first
 * version of this file did not, and it opened with fifty-odd complaints about
 * `src/http.ts` and `test/session_owner.test.mjs` — paths no version of this
 * package has ever contained. A reader learns once that source and tests live
 * in the repository; nothing is trapped by that. The trap is a directory that
 * is half here: `docs/` ships, so `docs/<anything>` reads as present, and the
 * day one subdirectory stops shipping every sentence pointing into it turns
 * into a dead end without a single character changing. Which roots are half
 * here is read from what npm packs, not declared, so a root that starts or
 * stops shipping moves itself in and out of scope.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Top-level directories whose contents are addressable as repository paths. */
const ROOTS = [
  'bin',
  'conformance',
  'deploy',
  'dist',
  'docs',
  'examples',
  'public',
  'scripts',
  'src',
  'standards',
  'test',
  'test-vectors',
]
const PATH_RE = new RegExp(
  `(?:^|[\\s\`(\\[<])((?:${ROOTS.join('|')})/[A-Za-z0-9._\\-/]+\\.[A-Za-z0-9]+)`,
  'g',
)

/**
 * Records of what was true on a past date. They name paths that have since
 * moved or gone, and rewriting them to keep a link alive would be falsifying
 * the record rather than fixing a link.
 */
const HISTORICAL = /^(CHANGELOG\.md|docs\/claims\/|docs\/releases\/|docs\/audit\/)/

function packedFiles() {
  const out = execFileSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  const parsed = JSON.parse(out.trim())
  const listing = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  if (!listing?.files?.length) throw new Error('npm pack --dry-run returned no file list')
  return listing.files.map((f) => f.path.split(String.fromCharCode(92)).join('/'))
}

const packed = packedFiles()
const shipped = new Set(packed)

/**
 * Roots the package ships from. A root with nothing packed under it is out of
 * scope entirely — see the note at the top of this file.
 */
const SHIPPED_ROOTS = new Set(
  ROOTS.filter((r) => packed.some((p) => p.startsWith(`${r}/`))),
)

const failures = []
let read = 0

for (const rel of packed) {
  if (!rel.endsWith('.md')) continue
  if (HISTORICAL.test(rel)) continue
  read += 1
  const text = readFileSync(join(root, rel), 'utf-8')
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    for (const m of line.matchAll(PATH_RE)) {
      const target = m[1]
      if (shipped.has(target)) continue
      if (!SHIPPED_ROOTS.has(target.split('/')[0])) continue
      // Present in the repository, absent from the package: the reader who
      // installed it cannot follow this, and the writer could not have known.
      if (existsSync(join(root, target))) {
        failures.push(`${rel}:${i + 1} → ${target}`)
      }
    }
  }
}

if (failures.length) {
  console.error(
    'pack path refs RED — shipped documents point at files the package does not ship:\n  ' +
      failures.join('\n  '),
  )
  console.error(
    '\n  Either ship the path, or rewrite the reference to say where it lives and that it\n' +
      '  is not in the package. A bare repository path reads as a file the reader has.',
  )
  process.exit(1)
}

console.log(
  `pack path refs GREEN — ${read} shipped document(s) read, every repository path they name ` +
    `is either in the package or absent from the tree`,
)
