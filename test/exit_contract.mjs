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
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * Two inputs that are valid JSON and are not receipts this tool can read.
 * Built here rather than committed, so the fixture cannot drift from the case
 * it is for, and so `test-vectors/` gains no file that is not a vector.
 *
 * `pretty.json` is the one an outside reader hit first: a JSON object with
 * newlines in it. The loader splits on newlines unless the file starts with
 * `[`, so the opening brace is handed to JSON.parse on its own and the tool
 * answers "invalid JSON" about a file that is valid JSON. The array case was
 * thought of; the pretty-printed object was not.
 *
 * `mixed/` is where a user actually meets it. Directory mode reads `.json`
 * alongside `.jsonl`, so a metadata file sitting next to the receipts stops
 * the run — which is what happens when the verifier is pointed at our own
 * published `test-vectors/` and reaches `expected-hashes.json`.
 */
const tmp = mkdtempSync(join(tmpdir(), 'cnr-exit-'))
const PRETTY = join(tmp, 'pretty.json')
writeFileSync(PRETTY, '{\n  "a": 1\n}\n')

const MIXED = join(tmp, 'mixed')
mkdirSync(MIXED)
copyFileSync(join(root, VALID), join(MIXED, 'receipts.jsonl'))
writeFileSync(join(MIXED, 'expected-hashes.json'), '{\n  "note": "not a receipt"\n}\n')

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
  // A target that is not there is answered as a target that is not there,
  // whether or not an unrelated flag was supplied. Until 0.2.45 the key was
  // loaded first, so the same missing file answered 13 without --pubkey and 2
  // with it: which wrong answer a caller saw was a fact about check order.
  ['verify', [ABSENT], USAGE, 'missing target is 2 with no --pubkey too'],
  ['coverage', [ABSENT], USAGE, 'missing target is 2 with no --pubkey too'],

  // --- an input that could not be read as receipts is not a schema verdict --
  ['verify', [PRETTY, '--pubkey', KEY], USAGE, 'valid JSON that is not JSONL'],

  // --- --help is a request that was served, not a failure ------------------
  ['verify', ['--help'], 0, '--help is 0'],
  ['coverage', ['--help'], 0, '--help is 0'],
  ['reconcile', ['--help'], 0, '--help is 0'],
  ['stamp', ['--help'], 0, '--help is 0'],
]

let passed = 0
let invocations = 0
const failures = []

function invoke(tool, args) {
  invocations += 1
  return spawnSync(
    process.execPath,
    [join(root, 'bin', `conarium-${tool}.mjs`), ...args],
    { cwd: root, encoding: 'utf-8' },
  )
}

for (const [tool, args, want, why] of CASES) {
  const got = invoke(tool, args).status
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

/**
 * An exit code says which class the answer is in. What went wrong is in the
 * message, so the message has to be true — a correct code attached to a false
 * sentence is not half right. The first of these is the one an outside reader
 * flagged ahead of the code itself, and they were right about which half a
 * user acts on.
 */
function run(tool, args) {
  const r = invoke(tool, args)
  return { code: r.status, err: r.stderr ?? '', out: r.stdout ?? '' }
}

function expect(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}\n      ${detail}`)
}

{
  const r = run('verify', [PRETTY, '--pubkey', KEY])
  expect(
    'message for JSON that is not JSONL',
    !/invalid JSON/i.test(r.err),
    `says "invalid JSON" about a file that is valid JSON:\n      ${r.err.trim().split('\n')[0]}`,
  )
  expect(
    'message for JSON that is not JSONL names the real fact',
    /JSONL/i.test(r.err),
    `does not say the file is not JSONL, which is what is actually wrong:\n      ${r.err.trim().split('\n')[0]}`,
  )
}

{
  // Directory mode is asked for the receipts in a directory, not asserted over
  // every file in it. A neighbour it cannot read is skipped and named — skipped
  // silently would be this project's own recurring defect, reported as success.
  const r = run('verify', [MIXED, '--pubkey', KEY])
  expect(
    'directory mode verifies the receipts beside a file it cannot read',
    r.code === 0,
    `exited ${r.code} because of a neighbouring metadata file:\n      ${r.err.trim().split('\n')[0]}`,
  )
  expect(
    'directory mode names what it skipped',
    /expected-hashes\.json/.test(r.err) && /skip/i.test(r.err),
    'skipped a file without naming it, which reports success over something not examined',
  )
}

if (failures.length) {
  console.error(`exit contract FAIL\n\n  ${failures.join('\n\n  ')}\n`)
  console.error(`  ${passed} passed, ${failures.length} failed`)
  process.exit(1)
}

console.log(
  `exit contract GREEN — ${invocations} invocation(s), ${passed} assertion(s) across four binaries; ` +
    `nothing that reached no artefact answered inside the verdict range`,
)
