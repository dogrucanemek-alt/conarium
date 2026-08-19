#!/usr/bin/env node
/**
 * A version bump and its claims review travel together.
 *
 * The gate in `publish.yml` asks for the review record at publish time, which is
 * the last moment it can be asked for. It stopped 0.2.29 there and 0.2.31 there
 * again — both times with the number already on main, and the record written
 * against a diff that had been merged days earlier. Writing it under a release
 * that was meant to be one command is also how a record gets written short: the
 * gate is satisfied by a file, and at that moment a file is what is wanted.
 *
 * This check asks the same question one step earlier — in the pull request that
 * moves the number, where the diff under review is the diff in front of you. It
 * costs nothing on any other commit: the record for the current version is
 * already in the tree, so the check is green until someone bumps the version.
 *
 * It does not judge the record, and it cannot. Whether a reading happened is not
 * knowable from a file — `denetci.mjs` says so in its own header, and that limit
 * is not repaired by adding a second file-shaped check. This refuses one thing
 * only: a version reaching main with no record at all.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RECORD_DIR = 'docs/claims/reviews'

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
assert.ok(version, 'package.json must carry a version')

/**
 * The previous version comes from the records on disk, not from a second
 * hand-written list. A list of past releases maintained beside this file would
 * be one more copy of a fact the directory already holds.
 */
const order = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
const compare = (a, b) => {
  const [x, y] = [order(a), order(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return 0
}

const recorded = existsSync(join(root, RECORD_DIR))
  ? readdirSync(join(root, RECORD_DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort(compare)
  : []

const rel = `${RECORD_DIR}/${version}.md`
const path = join(root, rel)

if (!existsSync(path)) {
  const previous = recorded.filter((v) => compare(v, version) < 0).pop()
  const base = previous ? `v${previous}` : '<previous tag>'
  console.error(`release record MISSING for ${version} — expected ${rel}`)
  console.error('')
  console.error('  The version moved without a claims review. Read the diff and write one:')
  console.error('')
  console.error(`    node test/denetci.mjs input ${base} HEAD    # what changed on the claim surfaces`)
  console.error(`    node test/denetci.mjs record ${base} HEAD   # the record to fill in`)
  console.error('')
  console.error(`  Write it to ${rel} and commit it in this pull request. Leaving it for`)
  console.error('  the publish run means reviewing a diff that merged days ago.')
  process.exit(1)
}

const text = readFileSync(path, 'utf8')

assert.ok(
  new RegExp(`^#\\s+Claims review\\s+—\\s+${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(text),
  `${rel} must open with "# Claims review — ${version}" — a record copied from another release names the wrong version`,
)

assert.ok(
  /^- verdict: \S+/m.test(text),
  `${rel} must carry a "- verdict:" line; publish.yml reads it and stops on "blocked"`,
)

assert.ok(
  /^- surface: sha256:[0-9a-f]{64}\s*$/m.test(text),
  `${rel} must carry the "- surface: sha256:…" line from "node test/denetci.mjs record" — the gate compares it against the tree being published`,
)

assert.ok(
  /^## Findings\s*$/m.test(text),
  `${rel} must have a "## Findings" section — "none" is a valid and complete answer`,
)

console.log(
  `release record GREEN ${version} → ${rel} (${recorded.length} record(s) on disk)`,
)
