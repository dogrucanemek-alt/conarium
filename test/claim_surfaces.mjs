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
