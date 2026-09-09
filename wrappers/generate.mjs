#!/usr/bin/env node
// Generates the unscoped launcher packages that back the commands the README
// documents. `npx <name>` resolves a *package* name, never a bin name, so
// `npx conarium-verify` fails with E404 unless a package called
// conarium-verify exists — even though @conarium-ai/core ships that bin.
//
// Every launcher here is generated from one template on purpose: nine
// hand-copied packages drift, and a drifted launcher is a supply-chain
// surface wearing our name.
//
// Run: node wrappers/generate.mjs   (rewrites every wrapper/ directory)

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const core = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const CORE_NAME = core.name
const CORE_RANGE = `^${core.version}`
// LF, whatever the checkout did to the source file: these are published artefacts.
const LICENSE = readFileSync(join(repoRoot, 'LICENSE'), 'utf8').split('\r\n').join('\n')

// Only commands that appear in public documentation are published. A launcher
// for a command nobody is told to run buys nothing and still has to be kept alive.
const COMMANDS = [
  ['conarium', 'the Conarium gateway'],
  ['conarium-verify', 'verify a receipt chain'],
  ['conarium-countersign-verify', 'verify a countersignature'],
  ['conarium-init', 'write keys and a fail-closed config'],
  ['conarium-doctor', 'check an installation'],
  ['conarium-console', 'open the local console'],
  ['conarium-stamp', 'stamp a document'],
  ['conarium-coverage', 'report policy coverage'],
  ['conarium-reconcile', 'reconcile a chain against the source database'],
  ['conarium-anchor-service', 'submit a chain head for anchoring'],
  ['conarium-anchor-upgrade', 'upgrade pending anchor proofs'],
]

const cli = (name) => `#!/usr/bin/env node
'use strict'

// Launcher for \`${name}\`. This package holds no logic of its own: it resolves
// the command inside ${CORE_NAME} and hands over, unchanged.
//
// The exit code is forwarded verbatim and that is the whole contract. Conarium
// answers with exit codes — 0 intact, 13 signature invalid or unknown keyId,
// 14 inclusion proof present and false — so a launcher that normalised them
// would quietly destroy the guarantee it exists to deliver.

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const TARGET = ${JSON.stringify(name)}
const CORE = ${JSON.stringify(CORE_NAME)}

let corePackageJson
try {
  corePackageJson = require.resolve(CORE + '/package.json')
} catch {
  process.stderr.write(TARGET + ': cannot resolve ' + CORE + '.\\n')
  process.exit(1)
}

const corePkg = require(corePackageJson)
const relative = corePkg.bin && corePkg.bin[TARGET]
if (!relative) {
  process.stderr.write(
    TARGET + ': ' + CORE + '@' + corePkg.version + ' does not provide this command.\\n'
  )
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [path.join(path.dirname(corePackageJson), relative), ...process.argv.slice(2)],
  { stdio: 'inherit' }
)

if (result.error) {
  process.stderr.write(TARGET + ': ' + result.error.message + '\\n')
  process.exit(1)
}
// A child killed by a signal has no status. Exiting 0 there would report
// success for a run that never finished.
if (result.signal) process.exit(1)
process.exit(result.status === null ? 1 : result.status)
`

const readme = (name, what) => `# ${name}

Launcher for the \`${name}\` command (${what}).

\`\`\`bash
npx ${name} --help
\`\`\`

This package contains no logic. It resolves \`${name}\` inside
[\`${CORE_NAME}\`](https://www.npmjs.com/package/${CORE_NAME}), runs it, and forwards
the exit code unchanged. Install \`${CORE_NAME}\` directly if you want the library
as well as the commands.

Conarium reports its result through exit codes, so the forwarding is the point:

| Exit | Meaning |
| --- | --- |
| \`0\` | the records in the file are intact |
| \`13\` | signature invalid, or unknown keyId |
| \`14\` | inclusion proof present and false |

Documentation: <https://conarium.dev> · Source: <https://github.com/dogrucanemek-alt/conarium>

MIT licensed.
`

const pkg = (name, what) => ({
  name,
  version: '1.0.0',
  description: `Launcher for the ${name} command from ${CORE_NAME} (${what}).`,
  keywords: ['conarium', 'cli', 'audit', 'receipts', 'verification'],
  license: 'MIT',
  homepage: 'https://conarium.dev',
  repository: {
    type: 'git',
    url: 'git+https://github.com/dogrucanemek-alt/conarium.git',
    directory: `wrappers/${name}`,
  },
  bugs: { url: 'https://github.com/dogrucanemek-alt/conarium/issues' },
  engines: { node: '>=20' },
  bin: { [name]: 'bin/cli.cjs' },
  // Allow-list, never a denylist: this repo has already shipped a private key
  // to npm once because the package listed directories instead of contents.
  files: ['bin/cli.cjs', 'README.md', 'LICENSE'],
  dependencies: { [CORE_NAME]: CORE_RANGE },
})

for (const [name, what] of COMMANDS) {
  const dir = join(here, name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg(name, what), null, 2) + '\n')
  writeFileSync(join(dir, 'bin', 'cli.cjs'), cli(name))
  writeFileSync(join(dir, 'README.md'), readme(name, what))
  writeFileSync(join(dir, 'LICENSE'), LICENSE)
  process.stdout.write(`generated wrappers/${name} -> ${CORE_NAME}@${CORE_RANGE}\n`)
}
