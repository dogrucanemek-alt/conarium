#!/usr/bin/env node
/**
 * Standalone locale-letter scan. SURFACES comes from claim_discipline.
 */
import { scanLocaleLetters, SURFACES } from './claim_discipline.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { failures, skipped } = scanLocaleLetters({ surfaces: SURFACES, rootDir: root })
if (failures.length) {
  console.error(`locale letters RED ${failures.join(' ')}`)
  process.exit(1)
}
console.log(`locale letters GREEN skipped=${skipped.join(',')} surfaces=${SURFACES.length}`)
