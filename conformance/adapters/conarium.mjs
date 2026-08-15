#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const helper = join(root, 'scripts', 'gacs-query-adapter.mjs')
const r = spawnSync(process.execPath, [helper, ...process.argv.slice(2)], {
  encoding: 'utf8',
  cwd: root,
  windowsHide: true,
})
if (r.stdout) process.stdout.write(r.stdout)
if (r.status) {
  if (!r.stdout) process.stderr.write(r.stderr || 'query helper failed\n')
  process.exit(r.status)
}
