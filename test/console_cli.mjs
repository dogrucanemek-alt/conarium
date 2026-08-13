/**
 * conarium-console launcher tests.
 *
 * This command starts a web UI that edits the policy protecting production
 * data. Every test here is about refusing to start in a state the operator did
 * not choose: no token, or an address that is not loopback.
 */
import assert from 'assert'
import path from 'path'
import http from 'http'
import { spawnSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'bin', 'conarium-console.mjs')

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function run(args = [], env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CONARIUM_CONSOLE_TOKEN: '',
      CONARIUM_CONSOLE_PUBLIC: '',
      CONARIUM_AUDIT_SIGNING_KEY: '',
      CONARIUM_AUDIT_HMAC_KEY: '',
      CONARIUM_AUDIT_UNSIGNED: '',
      ...env,
    },
  })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const freePort = () =>
  new Promise((res) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })

test('without a token it refuses to start and names the variable', async () => {
  const { status, out } = run()
  assert.strictEqual(status, 2, 'missing token must exit 2')
  assert.ok(/CONARIUM_CONSOLE_TOKEN/.test(out), 'must name the variable')
  assert.ok(/protect production data|unauthenticated/.test(out), 'must say why it refuses')
})

test('without audit signing it names the variable instead of throwing a stack', async () => {
  const { status, out } = run([], { CONARIUM_CONSOLE_TOKEN: 'tok-for-test' })
  assert.strictEqual(status, 2, 'missing audit config must exit 2')
  assert.ok(/CONARIUM_AUDIT_SIGNING_KEY/.test(out), 'must name the variable')
  assert.ok(/conarium-init/.test(out), 'must point at the command that creates a key')
  assert.ok(!/at Audit\.|dist[\\/]audit\.js/.test(out), 'must not surface a raw stack trace')
})

test('a non-loopback bind is refused unless it was chosen explicitly', async () => {
  const { status, out } = run(['--host', '0.0.0.0'], { CONARIUM_CONSOLE_TOKEN: 'tok-for-test', CONARIUM_AUDIT_UNSIGNED: '1' })
  assert.strictEqual(status, 2)
  assert.ok(/loopback/.test(out), 'must explain what it refused')
  assert.ok(/CONARIUM_CONSOLE_PUBLIC/.test(out), 'must name the opt-in')
})

test('SECRET: the token value is never echoed', async () => {
  const secret = 'console-token-do-not-print-8811'
  const { out } = run(['--host', '0.0.0.0'], { CONARIUM_CONSOLE_TOKEN: secret, CONARIUM_AUDIT_UNSIGNED: '1' })
  assert.ok(!out.includes(secret), 'token leaked into output')
})

test('an invalid port is refused', async () => {
  const { status, out } = run(['--port', 'abc'], { CONARIUM_CONSOLE_TOKEN: 'tok-for-test', CONARIUM_AUDIT_UNSIGNED: '1' })
  assert.strictEqual(status, 2)
  assert.ok(/port/.test(out))
})

test('with a token it listens on loopback and demands auth', async () => {
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, '--port', String(port)], {
    env: { ...process.env, CONARIUM_CONSOLE_TOKEN: 'tok-for-test', CONARIUM_AUDIT_UNSIGNED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    // wait for the port to answer
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      up = await new Promise((res) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (r) => {
          r.resume()
          res(true)
        })
        req.on('error', () => res(false))
        req.on('timeout', () => {
          req.destroy()
          res(false)
        })
      })
      if (!up) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(up, 'console did not start listening')

    const status = await new Promise((res) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/policy', timeout: 2000 }, (r) => {
          r.resume()
          res(r.statusCode)
        })
        .on('error', () => res(0))
    })
    assert.ok(status === 401 || status === 403 || status === 404, `an unauthenticated API call must not succeed, got ${status}`)
  } finally {
    child.kill()
  }
})

for (const { name, fn } of tests) {
  try {
    await fn()
    passCount++
    console.log(`PASS  ::  ${name}`)
  } catch (err) {
    failCount++
    console.log(`FAIL  ::  ${name}\n        ${err.message}`)
  }
}
console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
process.exitCode = failCount > 0 ? 1 : 0
