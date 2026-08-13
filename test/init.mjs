/**
 * conarium-init tests.
 *
 * Init exists so the operator does not copy a config, an MCP block and a key
 * pair by hand — and forget the .keyid sidecar, which makes every receipt
 * verify as 13. The private key must never reach stdout: this output is what
 * they paste into a support email.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INIT = path.join(__dirname, '..', 'bin', 'conarium-init.mjs')
const DOCTOR = path.join(__dirname, '..', 'bin', 'conarium-doctor.mjs')

let passCount = 0
let failCount = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conarium-init-'))
}

function runInit(cwd, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [INIT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function runDoctor(cwd, { env = {}, args = ['--no-net'] } = {}) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CONARIUM_AUDIT_SIGNING_KEY: '', CONARIUM_AUDIT_TRUST_PUBKEYS: '', CONARIUM_MCP_TOKEN: '', ...env },
  })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

test('--help exits 0', () => {
  const { status, out } = runInit(tmpdir(), { args: ['--help'] })
  assert.strictEqual(status, 0)
  assert.ok(/conarium-init/.test(out))
})

test('clean write produces config + key pair + non-empty .keyid', () => {
  const dir = tmpdir()
  const { status, out } = runInit(dir)
  assert.strictEqual(status, 0, out)
  const configPath = path.join(dir, 'conarium.config.json')
  const priv = path.join(dir, 'audit-ed25519.pem')
  const pub = path.join(dir, 'audit-ed25519.pub.pem')
  const pubSidecar = pub + '.keyid'
  const privSidecar = priv + '.keyid'
  assert.ok(fs.existsSync(configPath), 'config missing')
  assert.ok(fs.existsSync(priv), 'private key missing')
  assert.ok(fs.existsSync(pub), 'public key missing')
  assert.ok(fs.existsSync(pubSidecar), '.pub.pem.keyid missing')
  assert.ok(fs.existsSync(privSidecar), '.pem.keyid missing — loadSigningKey needs it')
  const keyId = fs.readFileSync(pubSidecar, 'utf-8').trim()
  assert.ok(keyId.length > 0, '.keyid is empty')
  assert.strictEqual(fs.readFileSync(privSidecar, 'utf-8').trim(), keyId)
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  assert.ok(Array.isArray(cfg.connectors) && cfg.connectors.length >= 1)
  assert.ok(Array.isArray(cfg.policy.allowConnectors) && cfg.policy.allowConnectors.length >= 1)
  assert.ok(Array.isArray(cfg.policy.maskColumns) && cfg.policy.maskColumns.length >= 1)
  assert.deepStrictEqual(cfg.policy.allowTables, [])
  assert.ok(out.includes(configPath) || out.includes('conarium.config.json'))
})

test('SECRET: the private key body never reaches stdout', () => {
  const dir = tmpdir()
  const { status, out } = runInit(dir)
  assert.strictEqual(status, 0, out)
  const pem = fs.readFileSync(path.join(dir, 'audit-ed25519.pem'), 'utf-8')
  assert.ok(pem.includes('BEGIN PRIVATE KEY'), 'fixture: private PEM was not written')
  assert.ok(!out.includes('BEGIN PRIVATE KEY'), 'private PEM header leaked to stdout')
  assert.ok(!out.includes('BEGIN OPENSSH PRIVATE KEY'), 'openssh private header leaked')
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  assert.ok(body.length > 20, 'fixture: PEM body empty')
  assert.ok(!out.replace(/\s+/g, '').includes(body), 'private key body leaked to stdout')
})

test('refuses to overwrite without --force and names the file', () => {
  const dir = tmpdir()
  const first = runInit(dir)
  assert.strictEqual(first.status, 0, first.out)
  const second = runInit(dir)
  assert.strictEqual(second.status, 1, 'must refuse overwrite')
  assert.ok(/refusing to overwrite/.test(second.out))
  assert.ok(/conarium\.config\.json/.test(second.out), 'must name the colliding file')
})

test('--force overwrites', () => {
  const dir = tmpdir()
  assert.strictEqual(runInit(dir).status, 0)
  const before = fs.readFileSync(path.join(dir, 'conarium.config.json'), 'utf-8')
  const again = runInit(dir, { args: ['--force'] })
  assert.strictEqual(again.status, 0, again.out)
  const after = fs.readFileSync(path.join(dir, 'conarium.config.json'), 'utf-8')
  assert.ok(after.length > 0)
  JSON.parse(after)
  void before
})

test('generated config + key makes conarium-doctor --no-net exit 0', () => {
  const dir = tmpdir()
  const init = runInit(dir)
  assert.strictEqual(init.status, 0, init.out)
  const priv = path.join(dir, 'audit-ed25519.pem')
  const pub = path.join(dir, 'audit-ed25519.pub.pem')
  const { status, out } = runDoctor(dir, {
    env: {
      CONARIUM_AUDIT_SIGNING_KEY: priv,
      CONARIUM_AUDIT_TRUST_PUBKEYS: pub,
    },
  })
  assert.strictEqual(status, 0, `doctor must accept init output:\n${out}`)
})

/**
 * 0.2.0'da yayinlanan kusur: `--out <dir>` ile kurulunca init'in kendi yazdirdigi
 * `conarium-doctor --no-net` komutu FAIL ediyordu — config <dir> altina yaziliyor,
 * doctor cwd'ye bakiyordu. Asagidaki iki test "aracin soyledigi komut calisir" ve
 * "yapistirilan MCP blogu gercekten yonetir" sartlarini kilitler.
 */
test('--out: init KENDI yazdirdigi doctor komutu basarili olmali', () => {
  const dir = tmpdir()
  const out = path.join(dir, '_keys')
  const init = runInit(dir, { args: ['--out', '_keys'] })
  assert.strictEqual(init.status, 0, init.out)

  const configPath = path.join(out, 'conarium.config.json')
  assert.ok(fs.existsSync(configPath), 'config --out dizinine yazilmadi')
  assert.ok(
    init.out.includes(`--config ${configPath}`),
    `Next satiri --config tasimiyor; kullanici FAIL alir:\n${init.out}`,
  )

  // Yazdirilan komut cwd'den BAGIMSIZ calismali: config'in olmadigi bir dizinden kosuyoruz.
  const elsewhere = tmpdir()
  const doctor = runDoctor(elsewhere, {
    args: ['--config', configPath, '--no-net'],
    env: {
      CONARIUM_AUDIT_SIGNING_KEY: path.join(out, 'audit-ed25519.pem'),
      CONARIUM_AUDIT_TRUST_PUBKEYS: path.join(out, 'audit-ed25519.pub.pem'),
    },
  })
  assert.strictEqual(doctor.status, 0, `init'in yazdirdigi komut FAIL etti:\n${doctor.out}`)
})

test('MCP blogu --config tasir (yoksa gecit sifir connector ile SESSIZCE acilir)', () => {
  for (const args of [[], ['--out', '_keys']]) {
    const dir = tmpdir()
    const init = runInit(dir, { args })
    assert.strictEqual(init.status, 0, init.out)
    const configPath = path.join(args.length ? path.join(dir, '_keys') : dir, 'conarium.config.json')

    const json = init.out.slice(init.out.indexOf('{'), init.out.lastIndexOf('}') + 1)
    const block = JSON.parse(json)
    const serverArgs = block.mcpServers.conarium.args
    assert.ok(
      serverArgs.includes('--config'),
      `MCP blogu --config tasimiyor (args=${JSON.stringify(serverArgs)}); istemci sunucuyu KENDI cwd'sinde baslatir`,
    )
    assert.strictEqual(serverArgs[serverArgs.indexOf('--config') + 1], configPath, 'MCP blogundaki config yolu yanlis')
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
process.exit(failCount > 0 ? 1 : 0)
