#!/usr/bin/env node
/**
 * `conarium --demo`, as a process.
 *
 * src/demo-mode.test.ts exercises bootDemo() in-process. That leaves the CLI
 * entry itself unmeasured: a line written to stdout in main(), or an update
 * check called on the demo path, would pass every test there. This check runs
 * the built entry the way an MCP client does and measures three things:
 *
 *   1. every line on stdout is a JSON-RPC frame, from the first byte on;
 *   2. the demo path opens no network connection (a preload records any
 *      fetch, http(s) request or non-loopback socket);
 *   3. NODE_ENV=production exits non-zero with nothing on stdout.
 *
 * Needs dist/, which `npm run test:checks` builds first.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'dist', 'index.js')
assert.ok(existsSync(entry), 'dist/index.js is missing; run `npm run build` first')

const work = mkdtempSync(join(tmpdir(), 'conarium-demo-cli-'))
const marker = join(work, 'network.log')
const preload = join(work, 'no-network.cjs')
writeFileSync(
  preload,
  `
const fs = require('node:fs')
const note = (what) => { try { fs.appendFileSync(${JSON.stringify(marker)}, what + '\\n') } catch {} }
const loopback = (h) => !h || h === 'localhost' || h === '127.0.0.1' || h === '::1'
const realFetch = globalThis.fetch
if (realFetch) globalThis.fetch = (...a) => { note('fetch ' + String(a[0])); return realFetch(...a) }
for (const name of ['node:http', 'node:https']) {
  const mod = require(name)
  const real = mod.request
  mod.request = (...a) => { note(name + ' request'); return real.apply(mod, a) }
}
const net = require('node:net')
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...a) {
  const o = typeof a[0] === 'object' && a[0] !== null ? a[0] : { port: a[0], host: a[1] }
  if (o.port !== undefined && !loopback(o.host)) note('socket ' + o.host + ':' + o.port)
  return realConnect.apply(this, a)
}
`,
)

function run(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, entry, '--demo'], {
      env: { ...process.env, NODE_ENV: '', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
    const done = (code) => resolve({ code, out, err })
    child.on('exit', done)
    const timer = setTimeout(() => child.kill(), 15_000)
    child.on('exit', () => clearTimeout(timer))
    if (extraEnv?.NODE_ENV === 'production') return
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo-cli-check', version: '0' } },
    })
    const poll = setInterval(() => {
      const lines = out.split('\n').filter(Boolean)
      if (lines.some((l) => l.includes('"id":1'))) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      }
      if (lines.some((l) => l.includes('"id":2'))) {
        clearInterval(poll)
        // Leave a moment for anything the entry might still do after the handshake.
        setTimeout(() => child.kill(), 1500)
      }
    }, 100)
    child.on('exit', () => clearInterval(poll))
  })
}

try {
  const live = await run({})
  const lines = live.out.split('\n').filter(Boolean)
  assert.ok(lines.length >= 2, `expected the two answers on stdout, read ${lines.length} line(s); stderr: ${live.err.slice(0, 300)}`)
  for (const line of lines) {
    let frame
    assert.doesNotThrow(() => (frame = JSON.parse(line)), `stdout carried a line that is not JSON: ${line.slice(0, 120)}`)
    assert.equal(frame.jsonrpc, '2.0', `stdout carried a line that is not a JSON-RPC frame: ${line.slice(0, 120)}`)
  }
  const tools = JSON.parse(lines.find((l) => l.includes('"id":2'))).result.tools.map((t) => t.name).sort()
  assert.deepEqual(tools, ['describe_table', 'list_tables', 'query', 'search'])
  assert.match(live.err.split('\n')[0], /demo mode/, 'the first stderr line must say this is demo mode')
  assert.ok(!existsSync(marker), `the demo path touched the network: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`)

  const prod = await run({ NODE_ENV: 'production' })
  assert.notEqual(prod.code, 0, 'NODE_ENV=production must exit non-zero')
  assert.equal(prod.out, '', 'NODE_ENV=production must write nothing to stdout')

  // The preload itself must be able to see a request, or the absence above proves nothing.
  const probe = spawnSync(
    process.execPath,
    ['--require', preload, '-e', "require('node:http').request('http://192.0.2.1/').on('error', () => {}).destroy()"],
    { encoding: 'utf8' },
  )
  assert.equal(probe.status, 0, probe.stderr)
  assert.ok(existsSync(marker) && /request/.test(readFileSync(marker, 'utf8')), 'the network preload recorded nothing for a real request')

  console.log('demo_cli: stdout is protocol only, no network on the demo path, production refused')
} finally {
  rmSync(work, { recursive: true, force: true })
}
