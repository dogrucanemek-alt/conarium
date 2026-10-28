#!/usr/bin/env node
/**
 * @conarium-ai/mask is the masking engine as its own small package, built
 * from the same source as @conarium-ai/core (src/mask.ts), so a program that
 * only masks does not install the gateway's server and database dependencies.
 * This check holds the package to what it says it is:
 *
 *   1. packages/mask/package.json is @conarium-ai/mask at the root's version
 *   2. its dependencies are exactly @eslint-community/regexpp and re2js, at
 *      the root's exact pins
 *   3. the built tree imports nothing outside those two packages
 *   4. npm would ship dist, README.md, LICENSE and package.json, nothing else
 *   5. importing the built entry starts nothing and masks a TCKN
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'packages', 'mask')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const DEPS = ['@eslint-community/regexpp', 're2js']

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

const pkgPath = join(dir, 'package.json')
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null
const entry = join(dir, 'dist', 'mask.js')

await check('package name and version', () => {
  assert.ok(pkg, 'packages/mask/package.json is missing')
  assert.equal(pkg.name, '@conarium-ai/mask')
  assert.equal(pkg.version, rootPkg.version, 'version differs from @conarium-ai/core')
})

await check('dependencies are the two the engine imports, at the root pins', () => {
  assert.ok(pkg, 'packages/mask/package.json is missing')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [...DEPS].sort())
  for (const d of DEPS) assert.equal(pkg.dependencies[d], rootPkg.dependencies[d], `${d} pin differs from the root`)
  assert.equal(pkg.devDependencies, undefined, 'no devDependencies in the published package')
})

await check('the built tree imports nothing else', () => {
  assert.ok(existsSync(entry), 'packages/mask/dist/mask.js is missing (does `npm run build` build it?)')
  const seen = new Set()
  const outside = new Set()
  const walk = (f) => {
    if (seen.has(f)) return
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const d = m[1] || m[2]
      if (d.startsWith('.')) walk(resolve(dirname(f), d))
      else if (!DEPS.some((x) => d === x || d.startsWith(x + '/'))) outside.add(d)
    }
  }
  walk(entry)
  assert.deepEqual([...outside], [], `imports outside the declared dependencies: ${[...outside].join(', ')}`)
})

await check('npm ships dist, README.md, LICENSE and package.json only', () => {
  assert.ok(pkg, 'packages/mask/package.json is missing')
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(r.status, 0, r.stderr)
  const files = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].files.map((f) => f.path)
  for (const need of ['dist/mask.js', 'dist/mask.d.ts', 'README.md', 'LICENSE', 'package.json']) assert.ok(files.includes(need), `${need} is not shipped`)
  const extra = files.filter((f) => !/^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(f))
  assert.deepEqual(extra, [], `ships files outside dist: ${extra.join(', ')}`)
  const tests = files.filter((f) => /\.test\./.test(f))
  assert.deepEqual(tests, [], `ships test files: ${tests.join(', ')}`)
})

await check('LICENSE is the root LICENSE', () => {
  const lic = join(dir, 'LICENSE')
  assert.ok(existsSync(lic), 'packages/mask/LICENSE is missing')
  assert.equal(readFileSync(lic, 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'))
})

await check('importing the built entry starts nothing and masks', async () => {
  assert.ok(existsSync(entry), 'packages/mask/dist/mask.js is missing')
  const code = `const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write(m.maskSensitiveText('TCKN 10000000146'))`
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => { child.kill(); done({ code: null, out, err }) }, 10000)
    child.on('exit', (c) => { clearTimeout(t); done({ code: c, out, err }) })
  })
  assert.equal(r.code, 0, `exit ${r.code}\n${r.err.slice(0, 400)}`)
  assert.ok(!r.out.includes('10000000146'), `the TCKN survived: ${r.out}`)
})

if (failures.length) {
  console.log(`\nmask_package: ${failures.length} failed`)
  process.exit(1)
}
console.log('\nmask_package: all passed')
