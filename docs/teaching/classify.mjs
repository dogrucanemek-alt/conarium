#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const START = '2026-08-20 10:00:00'
const END = '2026-08-20 10:10:00'

function load(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const cols = line.split(',')
      return { object: cols[1], ts: cols[2] }
    })
}

function classify(sourceRows, deskRows) {
  const sObj = new Set(
    sourceRows.filter((r) => r.ts >= START && r.ts < END && r.object !== 'catalog').map((r) => r.object),
  )
  const gIn = new Set(deskRows.filter((r) => r.ts >= START && r.ts < END).map((r) => r.object))
  const gAll = new Set(deskRows.map((r) => r.object))
  const attributed = []
  const observed = []
  const indeterminate = []
  for (const o of [...sObj].sort()) {
    if (gIn.has(o)) attributed.push(o)
    else if (!gAll.has(o)) observed.push(o)
    else indeterminate.push(o)
  }
  return { attributed, 'observed-without-receipt': observed, indeterminate }
}

const source = load(join(here, 'source.csv'))
const result = {
  step2: classify(source, load(join(here, 'desk.csv'))),
  step3: classify(source, load(join(here, 'desk-rewritten.csv'))),
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
