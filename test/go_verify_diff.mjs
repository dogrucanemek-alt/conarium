#!/usr/bin/env node
/**
 * Differential run: every frozen vector through Node and Go.
 * One exit-code mismatch is a failure. The vectors are the contract.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'test-vectors', 'manifest.json'), 'utf8'))
const nodeBin = join(root, 'bin', 'conarium-verify.mjs')
const goDir = join(root, 'verifiers', 'go')

function goBin() {
  if (process.env.GO_BIN && existsSync(process.env.GO_BIN)) return process.env.GO_BIN
  return 'go'
}

function builtVerifier() {
  const name = process.platform === 'win32' ? 'conarium-verify.exe' : 'conarium-verify'
  return join(goDir, name)
}

function runNode(file, args) {
  const r = spawnSync(process.execPath, [nodeBin, file, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status ?? 1
}

function runGo(file, args) {
  const r = spawnSync(builtVerifier(), [file, ...args], {
    cwd: goDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status ?? 1
}

const built = builtVerifier()
const compile = spawnSync(goBin(), ['build', '-o', built, '.'], {
  cwd: goDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (compile.status !== 0) {
  console.error('FAIL  go build')
  console.error(compile.stderr || compile.stdout)
  process.exit(1)
}

let failed = 0
for (const c of manifest.cases) {
  const file = join(root, 'test-vectors', c.name, 'receipts.jsonl')
  const args = c.args.map((a) => a.replace('KEYS/', join(root, 'test-vectors', 'keys') + '/'))
  const node = runNode(file, args)
  const go = runGo(file, args)
  const ok = node === c.exitCode && go === c.exitCode && node === go
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  expected ${c.exitCode}  node ${node}  go ${go}`)
  if (!ok) failed++
}

try {
  execFileSync(goBin(), ['vet', '.'], { cwd: goDir, stdio: 'pipe' })
  console.log('PASS  go vet')
} catch (err) {
  console.log('FAIL  go vet')
  console.error(err.stderr?.toString() || err.message)
  failed++
}

process.exit(failed === 0 ? 0 : 1)
