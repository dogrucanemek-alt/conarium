#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const nodes = raw.nodes || []
const self = new Map()
let total = 0
for (const node of nodes) {
  const hit = node.hitCount || 0
  if (!hit) continue
  total += hit
  const f = node.callFrame || {}
  const name = f.functionName || '(anonymous)'
  const url = (f.url || '').replace(/^file:\/\//, '')
  const line = typeof f.lineNumber === 'number' ? f.lineNumber + 1 : '?'
  const key = `${name}  ${url}:${line}`
  self.set(key, (self.get(key) || 0) + hit)
}
const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
for (const [key, hit] of ranked) {
  const pct = total ? ((100 * hit) / total).toFixed(1) : '0'
  console.log(`${String(hit).padStart(8)}  ${pct.padStart(5)}%  ${key}`)
}
console.log(`total hits ${total}`)
