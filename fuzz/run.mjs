#!/usr/bin/env node
/**
 * Drive the four Jazzer.js targets.
 *
 *   node fuzz/run.mjs                # short local / CI PR budget
 *   node fuzz/run.mjs --regression   # corpus only, no generation
 *   FUZZ_SECONDS=600 node fuzz/run.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const regression = process.argv.includes('--regression')
const seconds = Number(process.env.FUZZ_SECONDS || (regression ? 0 : 30))
const targets = ['sql-gate', 'receipt-jsonl', 'jcs', 'countersign']

if (!existsSync(join(root, 'dist', 'governance.js'))) {
  console.error('dist/ missing — run npm run build first')
  process.exit(2)
}

const jazzer = join(root, 'node_modules', '@jazzer.js', 'core', 'dist', 'cli.js')
if (!existsSync(jazzer)) {
  console.error('@jazzer.js/core is not installed')
  process.exit(2)
}

let failed = 0
for (const name of targets) {
  const target = join(root, 'fuzz', `${name}.fuzz.mjs`)
  const corpus = join(root, 'fuzz', 'corpus', name)
  mkdirSync(corpus, { recursive: true })
  const args = [jazzer, target, corpus, '-i', 'dist/', '--sync']
  if (regression) {
    args.push('--mode', 'regression')
  } else {
    args.push('--', `-max_total_time=${seconds}`, '-timeout=25')
  }
  console.log(`\n== ${name} ${regression ? 'regression' : `${seconds}s`} ==`)
  const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  const code = res.status ?? 1
  if (code !== 0) {
    failed += 1
    console.error(`${name} exited ${code}`)
  }
}

const crashes = []
for (const name of targets) {
  const dir = join(root, 'fuzz', 'corpus', name)
  if (!existsSync(dir)) continue
  for (const f of readdirSync(join(root))) {
    if (/^(crash|timeout|oom)-/.test(f)) crashes.push(f)
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/^(crash|timeout|oom)-/.test(f)) crashes.push(join(dir, f))
    }
  }
}
if (crashes.length) {
  console.error('known crashes:', crashes.join(', '))
  process.exit(1)
}
process.exit(failed === 0 ? 0 : 1)
