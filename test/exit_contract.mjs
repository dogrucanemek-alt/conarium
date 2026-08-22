#!/usr/bin/env node
/**
 * A code in the verdict range must be a verdict about something that was read.
 *
 * 0.2.42 fixed this for two paths in one binary and said so; the release note
 * named the uncaught-exception handler as the remainder and was wrong, because
 * the remainder had been found by reading the file rather than by running it.
 * `conarium-verify missing.jsonl` exited 20 — *Schema invalid* — with no
 * receipt opened, from a `return { code: 20 }` inside `loadReceipts` that no
 * eye scanning for `exit(20)` was going to see.
 *
 * This file runs the four binaries instead of reading them. Every case here is
 * an invocation that reaches no receipt, no declaration and no snapshot: a flag
 * that does not exist, a required argument that was not given, a path that is
 * not there. None of them may answer with a number that means the artefact was
 * inspected and found wanting.
 *
 * The regression half matters as much. A verdict that was correct before this
 * change must be identical after it, or the release traded one wrong answer for
 * another — so the vectors that exercise 0, 13 and 20 are run here too, from
 * the same table, in the same run.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'test-vectors/keys/vector-key.pub.pem'
const VALID = 'test-vectors/001-single-receipt/receipts.jsonl'
const BAD_SIG = 'test-vectors/006-bad-signature/receipts.jsonl'
const BAD_SCHEMA = 'test-vectors/007-schema-invalid/receipts.jsonl'

/** A path that does not exist, and must not be created by anything here. */
const ABSENT = 'this-path-does-not-exist-0e2f.jsonl'

const USAGE = 2

const CASES = [
  // --- the command could not be run as given: no artefact was reached ------
  ['verify', ['--file', 'x'], USAGE, 'unknown flag'],
  ['verify', [], USAGE, 'no arguments'],
  ['verify', [ABSENT, '--pubkey', KEY], USAGE, 'target not found'],
  ['coverage', ['--file', 'x'], USAGE, 'unknown flag'],
  ['coverage', [], USAGE, 'no arguments'],
  ['coverage', [ABSENT, '--pubkey', KEY], USAGE, 'declaration not found'],
  ['reconcile', ['--file', 'x'], USAGE, 'unknown flag'],
  ['reconcile', [], USAGE, 'no required flags'],
  [
    'reconcile',
    ['--before', ABSENT, '--after', ABSENT, '--receipts', ABSENT],
    USAGE,
    'snapshots not found',
  ],
  ['stamp', ['--file', 'x'], USAGE, 'unknown flag'],
  ['stamp', [], USAGE, 'no arguments'],
  ['stamp', [ABSENT], USAGE, 'target not found'],

  // --- verdicts, unchanged by this release --------------------------------
  ['verify', [VALID, '--pubkey', KEY], 0, 'valid chain is still 0'],
  ['verify', [BAD_SCHEMA, '--pubkey', KEY], 20, 'schema-invalid is still 20'],
  ['verify', [BAD_SIG, '--pubkey', KEY], 13, 'bad signature is still 13'],
  ['verify', [VALID], 13, 'missing --pubkey is still 13, fail-closed'],
  ['coverage', [ABSENT], 13, 'missing --pubkey is still 13, before the path is read'],

  // --- --help is a request that was served, not a failure ------------------
  ['verify', ['--help'], 0, '--help is 0'],
  ['coverage', ['--help'], 0, '--help is 0'],
  ['reconcile', ['--help'], 0, '--help is 0'],
  ['stamp', ['--help'], 0, '--help is 0'],
]

let passed = 0
const failures = []

for (const [tool, args, want, why] of CASES) {
  const run = spawnSync(
    process.execPath,
    [join(root, 'bin', `conarium-${tool}.mjs`), ...args],
    { cwd: root, encoding: 'utf-8' },
  )
  const got = run.status
  const label = `conarium-${tool} ${args.join(' ')}`.trim()
  if (got === want) {
    passed += 1
    continue
  }
  failures.push(
    `${label}\n      expected ${want} (${why}), got ${got}` +
      (want === USAGE && got >= 10
        ? '\n      a verdict code for an artefact that was never opened'
        : ''),
  )
}

if (failures.length) {
  console.error(`exit contract FAIL\n\n  ${failures.join('\n\n  ')}\n`)
  console.error(`  ${passed} passed, ${failures.length} failed`)
  process.exit(1)
}

console.log(
  `exit contract GREEN — ${passed} invocation(s) across four binaries; ` +
    `nothing that reached no artefact answered inside the verdict range`,
)
