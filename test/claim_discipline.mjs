#!/usr/bin/env node
/**
 * Public claims must not outrun what the code establishes.
 *
 * Four times now the same defect has been found by a reader rather than by us:
 * a sentence written once, believed ever after, and never checked against the
 * mechanism it describes. "covered by receipts" (the procedure established
 * object attribution), "proof of applied transformation" (it is a signed
 * assertion), "your data never crosses your perimeter" (releasing a governed
 * disclosure is the job), "immutable audit ledger" (a hash chain is
 * tamper-evident, not immutable).
 *
 * Documentation is where this product's argument lives, so a claim that
 * overstates is a defect in the product, not in the prose. This file fails the
 * build on the specific phrasings already found, and on the drift between two
 * documents that described the countersigning endpoint differently for two days.
 *
 * It is a regression test, not a style checker: every entry below is a sentence
 * that was actually published and actually wrong.
 *
 * Known gap: conarium.dev is served from a separate repository, and the same
 * page can exist in both. Fixing dpa.html here once left the live site
 * unchanged for exactly that reason. This file guards the surfaces in this
 * repository; the site needs the same guard on its own side.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SURFACES = [
  'README.md',
  'README.tr.md',
  'SECURITY.md',
  'LIMITATIONS.md',
  'LIMITATIONS.tr.md',
  'docs.html',
  'dpa.html',
  'terms.html',
  'privacy.html',
  'docs/ARCHITECTURE.md',
  'docs/RECEIPT-SPEC.md',
]

/**
 * Each rule is a phrasing that was published and was wrong, with the reason and
 * the wording that replaced it. `allow` exempts text that names the limit
 * instead of asserting past it.
 */
const BANNED = [
  {
    re: /\bimmutable\b/i,
    why: 'a hash chain is tamper-evident, not immutable: the file can still be deleted or truncated',
    use: 'tamper-evident',
  },
  {
    re: /never sees your secrets/i,
    why: 'masking hides a value; a predicate over a protected column can still answer questions about it',
    use: 'the values your policy protects are masked before they reach it',
  },
  {
    re: /without exposing a single secret/i,
    why: 'absolute, and contradicted by the inference channel this project documents itself',
    use: 'protected values masked before they leave',
  },
  {
    re: /every access is logged/i,
    why: 'only access through the gateway is logged — the reason conarium-reconcile exists at all',
    use: 'every access through Conarium is logged',
  },
  {
    re: /(?<!raw )(?:data|it) never (?:leaves|crosses) (?:your|the) perimeter/i,
    why: 'releasing a policy-approved disclosure to an AI client is what the product does',
    use: 'raw values stay in your perimeter — only policy-approved disclosure leaves',
  },
  {
    re: /covered by receipts/i,
    why: 'one receipt naming an object clears further statements against it: that is object attribution',
    use: 'attributable to receipt(s) for the same table',
  },
  {
    re: /proof of applied transformation/i,
    why: 'the payload is a signed assertion by the issuer, not proof the transformation ran',
    use: 'a signed assertion by the Issuer that the transformation was applied',
  },
  {
    // Found on 2026-08-17 in the site repository's README, which had not been read
    // since the claim sweep. It is a harder line than the others: LIMITATIONS says
    // there is no SOC 2 audit, so "SOC2-ready" is not an overstatement of a
    // mechanism, it is a statement about an audit that has not happened.
    re: /SOC\s?2[^.\n]{0,12}(ready|compliant|certified)/i,
    why: 'there is no SOC 2 audit; LIMITATIONS says so, and readiness is not ours to assert',
    use: 'name what exists — no SOC 2 audit, no independent penetration test',
  },
  {
    // Found on 2026-08-17 by a claim audit run over the surfaces this sweep had
    // not read. Instructive because the file was already in SURFACES below: the
    // guard was reading privacy.html and could not see this, because it only
    // knows phrasings that were already caught. The policy asserted the sentence
    // and then, four paragraphs later, itemised the waitlist email it stores,
    // the chat it forwards to a third-party model, and the host logs it keeps.
    // Read plainly, all three are the reader's data. terms.html asserted the
    // same thing with no itemisation at all.
    re: /never (?:receive,? see,? or store|see) your data/i,
    why: 'the website stores a waitlist email, forwards chat to a third-party model, and keeps host logs',
    use: 'scope it in the sentence — the data Conarium governs never reaches us',
  },
]

let checked = 0
const failures = []

for (const rel of SURFACES) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  checked++
  for (const rule of BANNED) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!rule.re.test(lines[i])) continue
      failures.push(
        `${rel}:${i + 1}  ${rule.re}\n` +
          `    why: ${rule.why}\n` +
          `    use: ${rule.use}\n` +
          `    line: ${lines[i].trim().slice(0, 140)}`,
      )
    }
  }
}

assert.ok(checked > 0, 'no surfaces were read — the path list is wrong')
assert.equal(
  failures.length,
  0,
  `claims that outrun the mechanism:\n\n${failures.join('\n\n')}\n`,
)

// ── drift: two documents describing the same fact differently ────────────────
//
// SECURITY.md said no public countersigning endpoint was operated, while
// LIMITATIONS said one had been running since 2026-08-15. Both were current;
// neither was updated when the other changed. Whichever way the fact moves, the
// two must move together.

const security = readFileSync(join(root, 'SECURITY.md'), 'utf8')
const limitations = readFileSync(join(root, 'LIMITATIONS.md'), 'utf8')

const limitsSayOperated = /Conarium-operated endpoint exists/i.test(limitations)
const securityDeniesOperated = /does not operate a\s+public countersigning endpoint/i.test(security)

assert.ok(
  !(limitsSayOperated && securityDeniesOperated),
  'drift: LIMITATIONS.md says a Conarium-operated countersigning endpoint exists, ' +
    'SECURITY.md says none is operated. One of them is stale.',
)

console.log(
  `claim discipline: ${checked} surfaces, ${BANNED.length} previously-published overclaims, no drift`,
)
