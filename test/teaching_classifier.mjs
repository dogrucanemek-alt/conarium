#!/usr/bin/env node
/**
 * The classroom classifier against its own answer key.
 *
 * The key is a file, not a comment, so changing the expected classes
 * turns the check red. That is the whole point of putting the key
 * next to the data rather than inside this runner.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const teaching = join(root, 'docs', 'teaching')
const keyPath = join(teaching, 'answer-key.json')

const raw = execFileSync(process.execPath, [join(teaching, 'classify.mjs')], {
  cwd: root,
  encoding: 'utf-8',
})
const got = JSON.parse(raw)
const key = JSON.parse(readFileSync(keyPath, 'utf-8'))

function sorted(list) {
  return [...list].sort()
}

for (const step of ['step2', 'step3']) {
  for (const cls of ['attributed', 'observed-without-receipt', 'indeterminate']) {
    assert.deepEqual(
      sorted(got[step][cls]),
      sorted(key[step][cls]),
      `${step} ${cls}: classifier=${JSON.stringify(got[step][cls])} key=${JSON.stringify(key[step][cls])}`,
    )
  }
}

process.stdout.write(raw)
console.log(`teaching classifier: step2 and step3 match ${keyPath.replace(/\\/g, '/')}`)
