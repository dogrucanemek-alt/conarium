#!/usr/bin/env node
/**
 * One measured threshold, three surfaces: JSON, BENCHMARK.md sentence, TS constant.
 * The markdown sentence is derived from the JSON — the number is not typed a
 * third time in this file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = JSON.parse(readFileSync(join(root, 'docs/benchmarks/masking-cost-threshold.json'), 'utf8'))
const warnAbove = raw.warnAbove
assert.equal(typeof warnAbove, 'number')
assert.ok(Number.isFinite(warnAbove), 'warnAbove must be a number')

const md = readFileSync(join(root, 'docs/BENCHMARK.md'), 'utf8')
const section = md.split('## Warning threshold')[1]
assert.ok(section, 'BENCHMARK.md must have a ## Warning threshold section')
const sentence = `\`docs/benchmarks/masking-cost-threshold.json\` → **warn above ${warnAbove}**.`
assert.ok(
  section.includes(sentence),
  `Warning threshold section must contain the sentence derived from JSON:\n  ${sentence}`,
)

const ts = readFileSync(join(root, 'src/masking-cost.ts'), 'utf8')
assert.ok(
  new RegExp(`MASKING_COST_WARN_ABOVE = ${warnAbove}\\b`).test(ts),
  `masking-cost.ts constant must equal JSON warnAbove (${warnAbove})`,
)

console.log(`threshold source GREEN warnAbove=${warnAbove} (JSON ↔ BENCHMARK.md ↔ masking-cost.ts)`)
