#!/usr/bin/env node
/**
 * Print a markdown build-record table for the preprint PDF.
 * Hashes and the commit are read from the tree. The container digest and the
 * SOURCE_DATE_EPOCH the build ran under are supplied as arguments; this script
 * does not invent either. Both belong in the row: pdfTeX stamps that epoch into
 * /CreationDate, so a reader who rebuilds without it gets a different PDF hash
 * and cannot tell a moved timestamp from a moved paper.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) return null
  const value = process.argv[i + 1]
  if (value.startsWith('-')) return null
  return value
}

function sha256OrMissing(rel) {
  const path = join(root, rel)
  if (!existsSync(path)) return 'not present'
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const container = argValue('--container')
const epoch = argValue('--epoch')
if (!container || !epoch) {
  console.error('usage: node paper/record-build.mjs --container <digest> --epoch <SOURCE_DATE_EPOCH>')
  process.exit(2)
}
if (!/^\d+$/.test(epoch)) {
  console.error(`--epoch must be the integer passed as SOURCE_DATE_EPOCH, not ${JSON.stringify(epoch)}`)
  process.exit(2)
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()

const pdf = sha256OrMissing('paper/build/main.pdf')
const tarball = sha256OrMissing('paper/build/two-ledgers-arxiv-source.tar.gz')
const date = new Date().toISOString()

process.stdout.write(
  [
    '| Field | Value |',
    '|---|---|',
    `| commit | ${commit} |`,
    `| PDF SHA-256 | ${pdf} |`,
    `| source tarball SHA-256 | ${tarball} |`,
    `| date | ${date} |`,
    `| container digest | ${container} |`,
    `| SOURCE_DATE_EPOCH | ${epoch} |`,
    '',
  ].join('\n'),
)
