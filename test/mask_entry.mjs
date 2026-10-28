#!/usr/bin/env node
/**
 * `@conarium-ai/core/mask` is the masking engine as a library.
 *
 * Importing `@conarium-ai/core` runs the stdio server: dist/index.js calls
 * main() on import. A program that only wants to mask a string (a gate in
 * front of an agent's tool calls, for one) had no entry it could import
 * without starting that server. This check holds the library entry to four
 * things, each from a separate Node process that resolves the package by
 * name, the way an installed consumer does:
 *
 *   1. `@conarium-ai/core/mask` resolves and imports with stdin left open,
 *      prints nothing, and the process exits on its own (no server started)
 *   2. it masks: a TCKN and an e-mail address do not survive, and the counts
 *      per class come back without the values
 *   3. `@conarium-ai/core/package.json` still resolves (the wrappers find the
 *      core's bin scripts through it)
 *   4. the package root still resolves to dist/index.js (the server entry)
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const TCKN = '10000000146'
const EMAIL = 'ayse.yilmaz@example.com'

// Runs `code` as an ES module from inside the package, so `@conarium-ai/core`
// resolves through the package's own "exports" (self-reference). Stdin stays
// open: a server that starts on import would keep the process alive.
function runModule(code, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, timedOut: true, stdout, stderr })
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut: false, stdout, stderr })
    })
  })
}

const failures = []
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`)
  }
}

await check('the mask entry imports without starting a server', async () => {
  const r = await runModule(`await import('@conarium-ai/core/mask')`)
  assert.equal(r.timedOut, false, 'the import did not return: something kept the process alive')
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(0, 600)}`)
  assert.equal(r.stdout, '', `the import wrote to stdout: ${r.stdout.slice(0, 200)}`)
})

await check('the mask entry masks and counts per class', async () => {
  const r = await runModule(`
    const m = await import('@conarium-ai/core/mask')
    const one = m.maskSensitiveText('TCKN ${TCKN}')
    const two = m.maskField('mail ${EMAIL}', { pipeline: 'text' })
    process.stdout.write(JSON.stringify({ one, two, names: Object.keys(m).sort() }))
  `)
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(0, 600)}`)
  const out = JSON.parse(r.stdout)
  assert.ok(!out.one.includes(TCKN), `the TCKN survived: ${out.one}`)
  assert.ok(!out.two.text.includes(EMAIL), `the e-mail survived: ${out.two.text}`)
  assert.ok(out.two.count >= 1, `count ${out.two.count}`)
  const counts = JSON.stringify(out.two.byClass)
  assert.ok(!counts.includes(EMAIL) && !counts.includes('example.com'), `byClass carries the value: ${counts}`)
  for (const name of ['compileCustomPatterns', 'maskField', 'maskSensitiveText']) {
    assert.ok(out.names.includes(name), `${name} is not exported: ${out.names.join(', ')}`)
  }
})

await check('package.json still resolves by name (the wrappers depend on it)', async () => {
  const r = await runModule(`
    import { createRequire } from 'node:module'
    const require = createRequire(${JSON.stringify(pathToFileURL(join(root, 'package.json')).href)})
    process.stdout.write(require.resolve('@conarium-ai/core/package.json'))
  `)
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(0, 600)}`)
  assert.equal(r.stdout, join(root, 'package.json'))
})

await check('the package root still resolves to the server entry', async () => {
  const r = await runModule(`process.stdout.write(import.meta.resolve('@conarium-ai/core'))`)
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(0, 600)}`)
  assert.equal(r.stdout, pathToFileURL(join(root, 'dist', 'index.js')).href)
})

if (failures.length) {
  console.log(`\nmask_entry: ${failures.length} failed`)
  process.exit(1)
}
console.log('\nmask_entry: all passed')
