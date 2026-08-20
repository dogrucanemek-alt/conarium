/**
 * Load the claim-surface list from its one source.
 *
 * Two hand-written arrays (denetci.mjs: 22, claim_discipline.mjs: 12)
 * drifted. The twelve were a silent subset of the twenty-two: every
 * phrasing-scan exemption was "we forgot to add the file". 0.2.36 then
 * shipped stale sentences in two of the ten that only denetci knew about.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SURFACES_SOURCE = join(root, 'docs/claims/surfaces.json')

const SOURCE_MISSING =
  'kural kaynağı yok — update the package: docs/claims/surfaces.json'

export function loadSurfaceRecords(sourcePath = SURFACES_SOURCE) {
  if (!existsSync(sourcePath)) {
    throw new Error(SOURCE_MISSING)
  }
  const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const raw = parsed.surfaces
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${SOURCE_MISSING} (surfaces[] empty or missing)`)
  }
  const seen = new Set()
  return raw.map((row, i) => {
    if (!row?.path || !row?.why) {
      throw new Error(`${SOURCE_MISSING} (surface ${i} missing path/why)`)
    }
    if (typeof row.phrasing !== 'boolean') {
      throw new Error(`${SOURCE_MISSING} (surface ${row.path} must set phrasing true|false — no silent default)`)
    }
    if (row.phrasing === false && !row.phrasingWhy) {
      throw new Error(`${SOURCE_MISSING} (surface ${row.path} is phrasing-exempt without phrasingWhy)`)
    }
    if (seen.has(row.path)) {
      throw new Error(`${SOURCE_MISSING} (duplicate path ${row.path})`)
    }
    seen.add(row.path)
    return {
      path: row.path,
      why: row.why,
      phrasing: row.phrasing,
      phrasingWhy: row.phrasingWhy || null,
    }
  })
}

export const SURFACE_RECORDS = loadSurfaceRecords()
export const SURFACES = SURFACE_RECORDS.map((s) => s.path)
export const PHRASING_SURFACES = SURFACE_RECORDS.filter((s) => s.phrasing).map((s) => s.path)

/** Documents that changed and are deliberately not read as promises. */
export const NOT_CLAIM_SURFACES = {
  'CHANGELOG.md': 'a record of what happened, not a promise about what the product does',
  'AGENTS.md': 'instructions to a contributor, not published to a reader',
  'PROJECT_CONTEXT.md': 'internal orientation, not published to a reader',
  'CONTRIBUTING.md': 'instructions to a contributor, not a promise about the product',
  'docs/security/best-practices-badge.md':
    'draft answers kept for provenance; the filed answers live at bestpractices.dev/projects/14160',
  'docs/security/scorecard-repo-settings.md':
    'a task list for someone with repo admin, not a statement about the product',
}

/**
 * Working records: written to be superseded. A promise does not live here.
 * Named as directories rather than inferred from depth — the depth rule is what
 * let `docs/security/THREAT-MODEL.md` sit in neither list.
 */
export const WORKING_RECORD_DIRS = [
  'docs/audit/',
  'docs/benchmarks/',
  'docs/claims/',
  'docs/dogfood/',
  'docs/plans/',
  'docs/releases/',
  'docs/reviews/',
  'docs/specs/',
  'docs/superpowers/',
]

/**
 * A changed document that nobody decided about.
 *
 * Depth used to do this filtering — top level, or one level under docs/. That
 * rule reads as a description of where promises live, but it is a description
 * of where the function happens to look, and the two came apart in
 * `docs/security/`: `NPM-PROVENANCE.md` was listed because someone put it there
 * by hand, and `THREAT-MODEL.md` beside it was on neither list with nothing to
 * say so.
 *
 * Internet-Drafts were excluded here too, on the ground that a posted draft is
 * immutable and its text was reviewed at submission. That is true of the posted
 * copy and false of this one. The repo file exists before it is posted, and
 * that window is the only one in which review can still change the text: -04
 * carried four statements about this implementation that were accurate when
 * written and false within days, and while they were still editable no
 * mechanism named the file. A repo copy that changes has either not been posted
 * yet or has drifted from what was posted, and both are decisions someone
 * should make on purpose.
 */
export function isUnlistedDoc(p, listed = new Set(SURFACES)) {
  return (
    !listed.has(p) &&
    !(p in NOT_CLAIM_SURFACES) &&
    !WORKING_RECORD_DIRS.some((d) => p.startsWith(d)) &&
    (/^[^/]+\.(md|html)$/.test(p) || /^docs\/.+\.md$/.test(p) || /^standards\/.+\.md$/.test(p))
  )
}
