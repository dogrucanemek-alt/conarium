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
 * It is a regression test, not a style checker: every entry in
 * docs/claims/retracted-phrasings.json is a sentence that was actually
 * published and actually wrong. The list lives there so the site repository
 * can load the same rules from the published package. A second copy of the
 * list is how the last overclaim survived.
 *
 * Known gap: conarium.dev is served from a separate repository, and the same
 * page can exist in both. Fixing dpa.html here once left the live site
 * unchanged for exactly that reason. This file guards the surfaces in this
 * repository; the site needs the same guard on its own side, reading this
 * file from node_modules/conarium-core/docs/claims/retracted-phrasings.json.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CLAIMS_SOURCE = join(root, 'docs/claims/retracted-phrasings.json')

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

const SOURCE_MISSING =
  'kural kaynağı yok — paketi güncelle: docs/claims/retracted-phrasings.json'

/**
 * Each rule is a phrasing that was published and was wrong, with the reason and
 * the wording that replaced it. `allow` exempts text that names the limit
 * instead of asserting past it.
 */
export function loadRules(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(SOURCE_MISSING)
  }
  const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const raw = parsed.rules
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${SOURCE_MISSING} (rules[] empty or missing)`)
  }
  return raw.map((rule, i) => {
    if (!rule?.re || !rule.why || !rule.use) {
      throw new Error(`${SOURCE_MISSING} (rule ${i} missing re/why/use)`)
    }
    return {
      id: rule.id || String(i),
      re: new RegExp(rule.re, rule.flags || ''),
      why: rule.why,
      use: rule.use,
      allow: rule.allow ? new RegExp(rule.allow, rule.allowFlags || rule.flags || '') : null,
    }
  })
}

function stripMarkup(line) {
  return line.replace(/<[^>]+>/g, ' ').replace(/\*+/g, ' ').replace(/\s+/g, ' ')
}

/**
 * Exported because test/claim_source.mjs asserts that the honest denials pass.
 * Asking the regex directly would test a matcher this file does not use: the
 * denial in SECURITY.md is written `**We do not have** SOC 2`, and the asterisks
 * sit between the words the pattern joins. A test that re-implements the
 * production path checks its own copy, not the code.
 */
export function allowedOn(line, allow) {
  if (!allow) return false
  if (allow.test(line)) return true
  return allow.test(stripMarkup(line))
}

export function snippetsOnLine(line, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const global = new RegExp(re.source, flags)
  const out = []
  let m
  while ((m = global.exec(line))) {
    const start = Math.max(0, m.index - 40)
    const end = Math.min(line.length, m.index + m[0].length + 40)
    out.push(line.slice(start, end).replace(/\s+/g, ' ').trim())
    if (out.length >= 8) break
  }
  return out
}

export function scanSurfaces({ surfaces, rootDir, rules }) {
  let checked = 0
  const failures = []
  for (const rel of surfaces) {
    const path = join(rootDir, rel)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    checked++
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const rule of rules) {
        if (!rule.re.test(lines[i])) continue
        if (allowedOn(lines[i], rule.allow)) continue
        const bits = snippetsOnLine(lines[i], rule.re)
        failures.push(
          `${rel}:${i + 1}  ${rule.re}\n` +
            `    why: ${rule.why}\n` +
            `    use: ${rule.use}\n` +
            `    hit: ${bits[0] || lines[i].trim().slice(0, 140)}` +
            (bits.length > 1 ? `\n    also: ${bits.slice(1).join(' | ')}` : ''),
        )
      }
    }
  }
  return { checked, failures }
}

function invokedDirectly() {
  const self = fileURLToPath(import.meta.url)
  const argv1 = process.argv[1] || ''
  return self.toLowerCase() === argv1.toLowerCase()
}

if (invokedDirectly()) {
  let rules
  try {
    rules = loadRules(CLAIMS_SOURCE)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  const { checked, failures } = scanSurfaces({ surfaces: SURFACES, rootDir: root, rules })

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
    `claim discipline: ${checked} surfaces, ${rules.length} previously-published overclaims, no drift`,
  )
}
