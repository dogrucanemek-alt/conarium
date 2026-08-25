#!/usr/bin/env node
/**
 * Differential run: every frozen vector through Node and Go.
 * One exit-code mismatch is a failure. The vectors are the contract.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  return runNodeArgs([file, ...args])
}

function runNodeArgs(args) {
  const r = spawnSync(process.execPath, [nodeBin, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status ?? 1
}

function runGo(file, args) {
  return runGoArgs([file, ...args])
}

function runGoArgs(args) {
  const r = spawnSync(builtVerifier(), args, {
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

const tmp = mkdtempSync(join(tmpdir(), 'cnr-go-diff-'))
const pretty = join(tmp, 'pretty.json')
writeFileSync(pretty, '{\n  "a": 1\n}\n')
const mixed = join(tmp, 'mixed')
mkdirSync(mixed)
copyFileSync(join(root, 'test-vectors', '001-single-receipt', 'receipts.jsonl'), join(mixed, 'receipts.jsonl'))
writeFileSync(join(mixed, 'expected-hashes.json'), '{\n  "note": "not a receipt"\n}\n')
const key = join(root, 'test-vectors', 'keys', 'vector-key.pub.pem')
const invocationCases = [
  ['help', ['--help'], 0],
  ['no arguments', [], 2],
  ['unknown flag', ['--not-a-real-flag'], 2],
  ['missing target', [join(tmp, 'missing.jsonl'), '--pubkey', key], 2],
  ['missing target without unrelated key flag', [join(tmp, 'missing.jsonl')], 2],
  ['valid JSON that is not JSONL', [pretty, '--pubkey', key], 2],
  ['directory skips named non-receipt JSON', [mixed, '--pubkey', key], 0],
]
for (const [name, args, expected] of invocationCases) {
  const node = runNodeArgs(args)
  const go = runGoArgs(args)
  const ok = node === expected && go === expected && node === go
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  expected ${expected}  node ${node}  go ${go}`)
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
