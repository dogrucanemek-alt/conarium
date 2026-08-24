#!/usr/bin/env node
/**
 * Print a markdown build-record table for the preprint PDF — and refuse to
 * print one that is not true of the tree it is run in.
 *
 * The first version only checked that the epoch was made of digits. An
 * adversarial review ran it with `--container latest --epoch 0` and got a
 * well-formed row naming a tag that moves and a date the build never used,
 * beside two real hashes. A provenance record that accepts whatever it is told
 * is not provenance; it is a nicer-looking assertion. So every field is now
 * measured against the artefacts or refused:
 *
 *   - the container must be named by digest, because a tag moves
 *   - both artefacts must exist; a missing one is an error, not a cell reading
 *     "not present"
 *   - the PDF must carry the epoch in /CreationDate and /ModDate, which is what
 *     makes its hash reproducible; a mismatch means the epoch in the row is not
 *     the epoch the build ran under
 *   - every tar member must be normalised to the same epoch, mode and owner,
 *     which is what makes the tarball hash reproducible
 *   - the working tree must be clean, so the commit in the row describes the
 *     sources the artefacts were built from
 *
 *   node paper/record-build.mjs --container <registry@sha256:...> --epoch <seconds>
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readInfoDict } from '../test/pdf_info_dict.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`record-build: ${message}`)
  process.exit(2)
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) return null
  const value = process.argv[i + 1]
  if (value.startsWith('-')) return null
  return value
}

function sha256(rel) {
  const path = join(root, rel)
  if (!existsSync(path)) {
    fail(`${rel} is not there. Build first; a row must describe files that exist.`)
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const container = argValue('--container')
const epoch = argValue('--epoch')
if (!container || !epoch) {
  fail('usage: node paper/record-build.mjs --container <registry@sha256:...> --epoch <seconds>')
}
if (!/^[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/.test(container)) {
  fail(
    `--container must name an image by digest, e.g. ghcr.io/owner/image@sha256:<64 hex>. ` +
      `A tag moves, so ${JSON.stringify(container)} does not identify the build.`,
  )
}
if (!/^\d+$/.test(epoch)) {
  fail(`--epoch must be the integer passed as SOURCE_DATE_EPOCH, not ${JSON.stringify(epoch)}`)
}

// The commit only describes the artefacts if nothing is uncommitted. Untracked
// files elsewhere in the repository are somebody's scratch and do not touch the
// build; an untracked file under paper/ could have been compiled into it, so
// those count as dirty too.
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((line) => line.trim() !== '')
const dirty = status.filter((line) => {
  if (!line.startsWith('?? ')) return true
  const path = line.slice(3).replace(/^"|"$/g, '')
  return path.startsWith('paper/') && !path.startsWith('paper/build/')
})
if (dirty.length > 0) {
  fail(
    `the working tree has changes the commit would not describe:\n  ${dirty.join('\n  ')}`,
  )
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

const pdfPath = 'paper/build/main.pdf'
const tarPath = 'paper/build/two-ledgers-arxiv-source.tar.gz'
const pdf = sha256(pdfPath)
const tarball = sha256(tarPath)

// --- the PDF must carry the epoch it claims ---------------------------------

const stamp = new Date(Number(epoch) * 1000)
const pad = (n, width = 2) => String(n).padStart(width, '0')
const expectedDate =
  `D:${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}` +
  `${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}Z`

const info = readInfoDict(readFileSync(join(root, pdfPath)))
if (!info) fail(`${pdfPath} has no /Info dictionary`)
for (const key of ['CreationDate', 'ModDate']) {
  if (info[key] !== expectedDate) {
    fail(
      `${pdfPath} carries /${key} ${JSON.stringify(info[key])}, but SOURCE_DATE_EPOCH ${epoch} ` +
        `means ${expectedDate}. Either the build did not run under that epoch, or this is not ` +
        `that build's PDF.`,
    )
  }
}

// --- every tar member must be normalised ------------------------------------

const tar = gunzipSync(readFileSync(join(root, tarPath)))
const members = []
for (let at = 0; at + 512 <= tar.length; ) {
  const name = tar.toString('latin1', at, at + 100).replace(/\0.*$/, '')
  if (name === '') break
  const octal = (from, length) => parseInt(tar.toString('latin1', from + at, from + at + length).replace(/[\0 ]/g, ''), 8) || 0
  const member = {
    name,
    mode: octal(100, 8) & 0o7777,
    uid: octal(108, 8),
    gid: octal(116, 8),
    size: octal(124, 12),
    mtime: octal(136, 12),
    content: tar.subarray(at + 512, at + 512 + octal(124, 12)),
  }
  members.push(member)
  at += 512 + Math.ceil(member.size / 512) * 512
}
if (members.length === 0) fail(`${tarPath} has no members`)

// What is in the package, and nothing else. Without this the tarball could
// carry anything at all and still be recorded, as long as the bytes it carried
// were normalised.
const ALLOWED = ['main.tex', 'refs.bib', 'main.bbl', 'LICENSE']
const names = members.map((m) => m.name)
if (names.length !== ALLOWED.length || names.some((name, i) => name !== ALLOWED[i])) {
  fail(
    `${tarPath} holds ${names.join(', ')}; the package is exactly ${ALLOWED.join(', ')} ` +
      `in that order`,
  )
}

// And it must be *this* commit's sources, not whatever was lying in the build
// directory. main.bbl is bibtex output and is not in the repository, so it is
// the one member this cannot bind; the PDF date check above is what ties the
// compile to the epoch.
const fromCommit = { 'main.tex': 'paper/arxiv/main.tex', 'refs.bib': 'paper/arxiv/refs.bib', LICENSE: 'paper/LICENSE' }
for (const [member, tracked] of Object.entries(fromCommit)) {
  const packaged = members.find((m) => m.name === member).content
  const committed = execFileSync('git', ['show', `${commit}:${tracked}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (Buffer.compare(packaged, committed) !== 0) {
    fail(
      `${tarPath} member ${member} is not ${tracked} at ${commit.slice(0, 12)}. ` +
        `The package would name a commit whose sources it does not carry.`,
    )
  }
}
for (const member of members) {
  const wrong = []
  if (member.mtime !== Number(epoch)) wrong.push(`mtime ${member.mtime} (expected ${epoch})`)
  if (member.uid !== 0 || member.gid !== 0) wrong.push(`owner ${member.uid}:${member.gid} (expected 0:0)`)
  if (member.mode !== 0o644) wrong.push(`mode ${member.mode.toString(8)} (expected 644)`)
  if (wrong.length > 0) {
    fail(
      `${tarPath} member ${member.name} is not normalised: ${wrong.join(', ')}. ` +
        `Un-normalised members make the tarball hash depend on the machine that built it.`,
    )
  }
}

const date = new Date().toISOString()

process.stdout.write(
  [
    '| Field | Value |',
    '|---|---|',
    `| commit | ${commit} |`,
    `| PDF SHA-256 | ${pdf} |`,
    `| source tarball SHA-256 | ${tarball} |`,
    `| tarball members | ${members.map((m) => m.name).join(', ')} |`,
    `| date | ${date} |`,
    `| container digest | ${container} |`,
    `| SOURCE_DATE_EPOCH | ${epoch} |`,
    '',
  ].join('\n'),
)
