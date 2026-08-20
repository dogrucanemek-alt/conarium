#!/usr/bin/env node
/**
 * The claims review gate — the one check a human has to answer.
 *
 * `test/claim_discipline.mjs` locks phrasings that were already caught. It
 * cannot find a new overclaim, and on 2026-08-17 that limit was measured rather
 * than argued: privacy.html asserted "We never receive, see, or store your data
 * or your customers' data" four paragraphs above its own inventory of the
 * waitlist email it stores, the chat it forwards to a third-party model, and the
 * host logs it keeps. claim_discipline.mjs was reading that exact file and saw
 * nothing, because the sentence had never been caught before. A guard locks the
 * known; only a reader finds the new.
 *
 * So this file does not judge anything. It bounds the input a reader gets, and
 * it asks, at release time, whether that reading happened:
 *
 *   node test/denetci.mjs input v0.2.25 HEAD   what changed on the claim surfaces
 *   node test/denetci.mjs record v0.2.25 HEAD  the review record to fill in
 *   node test/denetci.mjs gate                 the release gate (publish.yml)
 *
 * ── What the gate does and does not do ──────────────────────────────────────
 *
 * It never fails because of what the review found. Findings are printed as
 * warnings for a human to read, and a release ships with them. Judgment wired
 * to an automatic red would be switched off at the first arguable finding —
 * and the findings that matter are arguable, which is why a person reads them.
 *
 * It fails on three things, none of which is a judgment:
 *
 *   - no review record exists for the version about to ship
 *   - the claim surfaces changed after the review was written, so the review
 *     describes a text that is no longer the one being published
 *   - the reviewer wrote `verdict: blocked` — a person's own hand on the brake,
 *     not a machine's
 *
 * This makes forgetting impossible. It does not make lying impossible: a record
 * can be written without reading anything. That limit is deliberate, and stated
 * here rather than left for someone to discover.
 *
 * This file is not in `test/run-checks.mjs`. A gate that demands a review on
 * every commit would be red every day, and a check that is always red is a
 * check nobody reads.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SURFACES, isUnlistedDoc } from './claim_surfaces.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The documents a reader can take as a promise. The list itself lives in
 * `docs/claims/surfaces.json` — this file and `claim_discipline.mjs` both
 * read that file, so a document cannot be a review surface in one and
 * invisible to phrasing scan in the other. See NOT_CLAIM_SURFACES below
 * for documents that changed and are deliberately not read as promises.
 */

/**
 * NOT_CLAIM_SURFACES, WORKING_RECORD_DIRS and isUnlistedDoc live in
 * claim_surfaces.mjs beside the surface list itself. What counts as a claim
 * surface is one question; answering half of it here and half there is the
 * shape that produced the drift that file exists to end.
 */

/**
 * Not docs/audit/. `.gitignore` carries `audit/` to keep receipt chains — which
 * hold traces of customer data — out of the repository, and that pattern matches
 * any directory of that name at any depth. A record written there is invisible
 * to git, so CI checks out a tree without it and the gate fails on a review that
 * exists on the author's disk. Records live beside the rule source instead,
 * where the directory is unambiguously publishable.
 */
const RECORD_DIR = 'docs/claims/reviews'

const git = (args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/**
 * Line endings are not a claim. `git show` hands back the blob as stored while
 * a Windows working tree may hold CRLF, so hashing raw bytes would make a
 * review written on one machine look stale on another.
 */
const normalise = (text) => text.split('\r\n').join('\n')

/** Read a surface either from the working tree (rev === null) or from a rev. */
function readSurface(rev, rel) {
  if (rev === null) {
    const path = join(root, rel)
    return existsSync(path) ? normalise(readFileSync(path, 'utf-8')) : null
  }
  try {
    return normalise(git(['show', `${rev}:${rel}`]))
  } catch {
    return null
  }
}

/**
 * One hash over the whole claim surface, in list order, path included. A file
 * that is deleted, added to the list, or edited by one character all move it.
 */
function surfaceHash(rev) {
  const h = createHash('sha256')
  const present = []
  const absent = []
  for (const rel of SURFACES) {
    const text = readSurface(rev, rel)
    h.update(rel)
    h.update('\0')
    if (text === null) {
      h.update('<absent>')
      absent.push(rel)
    } else {
      h.update(text)
      present.push(rel)
    }
    h.update('\0')
  }
  return { hash: `sha256:${h.digest('hex')}`, present, absent }
}

/** The changed documents nobody decided about. The rule is in claim_surfaces.mjs. */
function unlistedDocs(base, head) {
  const changed = git(['diff', '--name-only', base, head])
    .split('\n')
    .map((p) => p.trim().split('\\').join('/'))
    .filter(Boolean)
  const listed = new Set(SURFACES)
  return changed.filter((p) => isUnlistedDoc(p, listed))
}

const PROMPT = `
# ── How to read this diff ────────────────────────────────────────────────────
#
# One question, asked of every changed sentence:
#
#     does this sentence say more than the mechanism behind it proves?
#
# A finding fills three fields. Missing one makes it an impression, not a
# finding, and impressions are what make a reviewer unreadable by week three:
#
#     Claim              the sentence itself, quoted exactly
#     Mechanism          what would establish it — which code, test, procedure
#     Why it falls short what that mechanism actually proves, and where the gap is
#
# Calibrated example of a real one:
#
#     Claim      "ok: every DB query pattern in the window is covered by receipts"
#     Mechanism  conarium-reconcile looks for a receipt naming the object in the window
#     Why it falls short  one receipt clears unlimited further statements in the same
#                window (test/reconcile_cli.test.mjs: 5 calls + 1 receipt = exit 0).
#                The procedure establishes attribution; "covered" asserts extent.
#
# Do NOT report style, grammar, tone or marketing voice. "Could be phrased
# better" is not a finding. Only a sentence that claims past its mechanism.
#
# Finding nothing is a valid and respectable answer. Inventing one to look
# useful is the failure this whole gate exists to prevent.
#
`.trim()

function cmdInput(base, head) {
  const { hash, present, absent } = surfaceHash(head)
  const unlisted = unlistedDocs(base, head)

  console.log(`# claims review input ${base}..${head}`)
  console.log(`# surface=${present.length} ${present.join(' ')}`)
  if (absent.length) console.log(`# absent=${absent.length} ${absent.join(' ')}`)
  console.log(`# surface-hash ${hash}`)
  for (const p of unlisted) {
    console.log(`# unlisted: ${p} — changed here, not read as a claim surface.`)
    console.log(`#   Add it to docs/claims/surfaces.json, or record why it is not one.`)
  }
  console.log()
  console.log(PROMPT)
  console.log()

  const diff = git(['diff', '--no-ext-diff', base, head, '--', ...SURFACES])
  if (!diff.trim()) {
    console.log(`# no claim surface changed between ${base} and ${head}.`)
    return 0
  }
  process.stdout.write(diff.endsWith('\n') ? diff : `${diff}\n`)
  return 0
}

function cmdRecord(base, head) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const { hash } = surfaceHash(head)
  const sha = git(['rev-parse', '--short', head]).trim()

  console.log(`# Claims review — ${version}

- base: ${base}
- head: ${sha}
- surface: ${hash}
- verdict: pass
- reviewer: <who read it>

## Findings

### 1. <file>:<line> — <the claim, shortened>

- Claim: <the sentence, quoted exactly>
- Mechanism: <what would establish it>
- Why it falls short: <what the mechanism proves, and where the gap is>
- Disposition: <accepted / reworded in \`<sha>\` / disputed — shipping anyway>

<!-- No findings? Replace everything under "## Findings" with the single word: none -->
`)
  console.log(`<!-- write this to ${RECORD_DIR}/${version}.md, then commit it -->`)
  return 0
}

function fail(message) {
  console.error(`\nclaims review gate: ${message}\n`)
  return 1
}

function cmdGate() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const rel = `${RECORD_DIR}/${version}.md`
  const path = join(root, rel)

  if (!existsSync(path)) {
    return fail(
      `no review of the claims in ${version}.\n\n` +
        `  ${rel} does not exist. Nothing here judges what you write — this step\n` +
        `  only refuses to publish text that no one has read.\n\n` +
        `    node test/denetci.mjs input v<previous> HEAD   read what changed\n` +
        `    node test/denetci.mjs record v<previous> HEAD  write the record, then commit it\n`,
    )
  }

  const text = normalise(readFileSync(path, 'utf-8'))
  const field = (name) => {
    const m = text.match(new RegExp(`^-\\s*${name}:\\s*(.+)$`, 'mi'))
    return m ? m[1].trim() : null
  }

  const recorded = field('surface')
  const verdict = (field('verdict') || '').toLowerCase()
  if (!recorded) return fail(`${rel} has no \`- surface:\` line, so it names no text.`)
  if (verdict !== 'pass' && verdict !== 'blocked') {
    return fail(`${rel} has \`- verdict: ${verdict || '(missing)'}\`; expected \`pass\` or \`blocked\`.`)
  }

  const { hash, present, absent } = surfaceHash(null)
  if (hash !== recorded) {
    return fail(
      `the claim surfaces changed after ${rel} was written.\n\n` +
        `    recorded ${recorded}\n` +
        `    now      ${hash}\n\n` +
        `  The review describes a text that is not the one about to ship. Re-read the\n` +
        `  difference and update the record:\n\n` +
        `    node test/denetci.mjs input ${field('head') || '<recorded head>'} HEAD\n`,
    )
  }

  const section = text.split(/^##\s+Findings\s*$/m)[1] ?? ''
  const body = section.split(/^##\s+/m)[0].trim()
  const findings = body.toLowerCase() === 'none' ? [] : body.split('\n').filter((l) => l.startsWith('### '))

  for (const line of findings) {
    const heading = line.replace(/^###\s+/, '').trim()
    const at = heading.match(/([\w./-]+\.(?:md|html)):(\d+)/)
    const where = at ? `file=${at[1]},line=${at[2]},` : ''
    console.log(`::warning ${where}title=Claims review::${heading}`)
  }

  console.log(
    `claims review: ${version} reviewed over ${present.length} claim surface(s)` +
      `${absent.length ? ` (${absent.length} absent)` : ''}, ` +
      `${findings.length} finding(s), verdict ${verdict} — ${rel}`,
  )

  if (verdict === 'blocked') {
    return fail(
      `${rel} says \`verdict: blocked\`.\n\n` +
        `  A finding never stops a release; this is the reviewer stopping it. Resolve it\n` +
        `  and set \`verdict: pass\`, or dispute the finding in its Disposition line.\n`,
    )
  }
  if (findings.length) {
    console.log('findings do not fail this step — they were read, and the release carries them.')
  }
  return 0
}

const [mode, base, head = 'HEAD'] = process.argv.slice(2)

try {
  if (mode === 'gate') process.exit(cmdGate())
  else if (mode === 'input' && base) process.exit(cmdInput(base, head))
  else if (mode === 'record' && base) process.exit(cmdRecord(base, head))
  else {
    console.error(
      'usage:\n' +
        '  node test/denetci.mjs input  <base> [head]   bounded diff of the claim surfaces\n' +
        '  node test/denetci.mjs record <base> [head]   review record to fill in and commit\n' +
        '  node test/denetci.mjs gate                   release gate, run by publish.yml\n',
    )
    process.exit(2)
  }
} catch (err) {
  console.error(`claims review: ${err.message}`)
  process.exit(2)
}
