#!/usr/bin/env node
'use strict'

// Launcher for `conarium-countersign-verify`. This package holds no logic of its own: it resolves
// the command inside @conarium-ai/core and hands over, unchanged.
//
// The exit code is forwarded verbatim and that is the whole contract. Conarium
// answers with exit codes — 0 intact, 13 signature invalid or unknown keyId,
// 14 inclusion proof present and false — so a launcher that normalised them
// would quietly destroy the guarantee it exists to deliver.

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const TARGET = "conarium-countersign-verify"
const CORE = "@conarium-ai/core"

let corePackageJson
try {
  corePackageJson = require.resolve(CORE + '/package.json')
} catch {
  process.stderr.write(TARGET + ': cannot resolve ' + CORE + '.\n')
  process.exit(1)
}

const corePkg = require(corePackageJson)
const relative = corePkg.bin && corePkg.bin[TARGET]
if (!relative) {
  process.stderr.write(
    TARGET + ': ' + CORE + '@' + corePkg.version + ' does not provide this command.\n'
  )
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [path.join(path.dirname(corePackageJson), relative), ...process.argv.slice(2)],
  { stdio: 'inherit' }
)

if (result.error) {
  process.stderr.write(TARGET + ': ' + result.error.message + '\n')
  process.exit(1)
}
// A child killed by a signal has no status. Exiting 0 there would report
// success for a run that never finished.
if (result.signal) process.exit(1)
process.exit(result.status === null ? 1 : result.status)
