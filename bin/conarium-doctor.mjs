#!/usr/bin/env node
/**
 * conarium-doctor — pre-flight diagnosis for a Conarium install.
 *
 * WHY THIS EXISTS
 * Conarium is meant to be installed once, by the operator, without us in the
 * loop. Every misconfiguration that produces a vague stack trace — or worse, a
 * process that starts happily and governs nothing — becomes a support email
 * from a timezone we cannot answer quickly. This tool converts those into a
 * checklist the operator can act on alone.
 *
 * TWO SILENT FAILURES IT EXISTS FOR (both real, both in the current code):
 *   1. `loadConfig()` returns an EMPTY config when the config file is missing
 *      (src/server.ts). A typo in the path yields a server that runs, logs one
 *      stderr line, and enforces nothing. Nothing crashes.
 *   2. Connector `connect()` failures are caught and logged, not thrown
 *      (src/server.ts). The gateway stays up with zero connectors.
 *
 * DESIGN RULES
 * - NO imports from src/ or dist/. The doctor must run when the build is
 *   broken, because that is exactly when it is needed. Node builtins only.
 * - NEVER print a secret. Operators paste this output into support email and
 *   CI logs. Passwords, tokens and key material are reported as shape only
 *   (set / not set, length, host — never the value).
 * - Exit codes stay OUT of the receipt exit-code namespace (10..50, see
 *   docs/RECEIPT-SPEC.md). The doctor is not part of the receipt protocol:
 *     0 = no failures (warnings allowed)
 *     1 = at least one failure
 *     2 = the doctor itself could not run
 */
import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { createPublicKey, createPrivateKey } from 'node:crypto'
import {
  dialectAgrees,
  dialectLine,
  familyFromBanner,
  familyFromScheme,
  resolveDoctorDialect,
} from './doctor-sql.mjs'

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const valueOf = (f, fallback) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback
}

if (has('--help') || has('-h')) {
  console.log(`conarium-doctor — check a Conarium install before it goes wrong

  --config <path>   config file (default: conarium.config.json in cwd)
  --no-net          skip the TCP reachability probe AND the npm version check
  --help            this text

Exit: 0 clean · 1 problems found · 2 doctor could not run
Secrets are never printed — values are reported as shape only.`)
  process.exit(0)
}

const CONFIG_PATH = resolve(process.cwd(), valueOf('--config', 'conarium.config.json'))
const SKIP_NET = has('--no-net')

const results = []
const ok = (label, detail) => results.push({ level: 'ok', label, detail })
const warn = (label, detail, fix) => results.push({ level: 'warn', label, detail, fix })
const fail = (label, detail, fix) => results.push({ level: 'fail', label, detail, fix })
/** Could not complete the check. Not a pass. Not a silent skip. */
const unseen = (label, detail, fix) => results.push({ level: 'unseen', label, detail, fix })

/* ---------------------------------------------------------------- helpers */

/** A DSN carries a password. Report only its shape. */
function describeDsn(raw) {
  try {
    const u = new URL(raw)
    const db = u.pathname.replace(/^\//, '') || '(none)'
    return {
      scheme: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port || (u.protocol === 'postgres:' || u.protocol === 'postgresql:' ? '5432' : ''),
      user: u.username || '(none)',
      hasPassword: Boolean(u.password),
      db,
      text: `${u.protocol}//${u.username || '(no user)'}@${u.hostname}${u.port ? ':' + u.port : ''}/${db}`,
    }
  } catch {
    return null
  }
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((done) => {
    const sock = new net.Socket()
    let settled = false
    // Resolve only once the socket is fully closed. Resolving on the error
    // event and exiting immediately used to abort the process on Windows —
    // libuv asserts when the handle is still closing (UV_HANDLE_CLOSING) —
    // and the run ended with 127 instead of the documented 0/1/2.
    const finish = (r) => {
      if (settled) return
      settled = true
      if (sock.destroyed) {
        done(r)
        return
      }
      sock.once('close', () => done(r))
      sock.destroy()
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish({ reachable: true }))
    sock.once('timeout', () => finish({ reachable: false, why: `no answer in ${timeoutMs}ms` }))
    sock.once('error', (e) => finish({ reachable: false, why: e.code || e.message }))
    sock.connect(Number(port), host)
  })
}

/** Ask a reachable engine who it is. Never log the DSN. */
async function identifyEngine(t) {
  const schemeFamily = familyFromScheme(t.scheme)
  const looksPostgres = schemeFamily === 'postgres' || t.type === 'postgres' || t.type === 'supabase'
  if (!looksPostgres) return null
  try {
    const postgres = (await import('postgres')).default
    const sql = postgres(t.raw, { max: 1, connect_timeout: 3, idle_timeout: 1 })
    try {
      const rows = await sql`select version() as v`
      const banner = String(rows?.[0]?.v || '')
      const family = familyFromBanner(banner)
      if (!family) return null
      return { family, summary: banner.split(',')[0].replace(/\s+/g, ' ').slice(0, 72) }
    } finally {
      await sql.end({ timeout: 2 })
    }
  } catch {
    return null
  }
}

function envSet(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

/* ------------------------------------------------------------- the checks */

// 1. Runtime
{
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(major)) warn('Node runtime', `unrecognised version ${process.version}`, 'Conarium expects Node >= 18.')
  else if (major < 18) fail('Node runtime', `${process.version} is below the supported floor`, 'Install Node 18 or newer.')
  else ok('Node runtime', process.version)
}

// 1b. Installed version vs npm registry.
//     Telemetry none: this is a GET for a version number. No install id, no
//     hostname, no config, no license is sent. A bank reading this file should
//     see that the only bytes leaving the box are an HTTP request for
//     @conarium-ai/core's `latest` document. `--no-net` makes zero requests.
{
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  let installed = null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (typeof pkg.version === 'string' && pkg.version) installed = pkg.version
  } catch {
    installed = null
  }
  if (!installed) {
    warn('Version', `could not read ${pkgPath}`, 'Reinstall the package so package.json sits next to bin/.')
  } else if (SKIP_NET) {
    ok('Version', `${installed} (registry not queried: --no-net)`)
  } else {
    const url = envSet('CONARIUM_NPM_REGISTRY') || 'https://registry.npmjs.org/@conarium-ai/core/latest'
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2000)
      let latest
      try {
        const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        latest = body && typeof body.version === 'string' ? body.version : null
        if (!latest) throw new Error('no version field')
      } finally {
        clearTimeout(timer)
      }
      if (latest === installed) {
        ok('Version', `${installed} (matches npm latest)`)
      } else if (cmpSemver(latest, installed) > 0) {
        warn(
          'Version',
          `${installed} installed; ${latest} is on npm`,
          `npm i @conarium-ai/core@${latest}`,
        )
      } else {
        ok('Version', `${installed} installed; npm latest is ${latest}`)
      }
    } catch (e) {
      warn(
        'Version',
        `${installed} installed; registry unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})`,
        'Air-gapped is fine. Rerun without --no-net when you next have a network, or pin the version yourself.',
      )
    }
  }
}

// 2. Config file — the silent one
let config = null
if (!existsSync(CONFIG_PATH)) {
  fail(
    'Config file',
    `not found at ${CONFIG_PATH}`,
    'Conarium does NOT fail on a missing config — it starts with zero connectors and governs nothing. ' +
      'Create the file, or pass --config <path> to both the doctor and the gateway.',
  )
} else {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8')
  } catch (e) {
    fail('Config file', `cannot read ${CONFIG_PATH}: ${e.code || e.message}`, 'Check file permissions.')
  }
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
      ok('Config file', CONFIG_PATH)
    } catch (e) {
      fail('Config file', `invalid JSON: ${e.message}`, 'Fix the syntax; the gateway will refuse to start until you do.')
    }
  }
}

// 3. Connectors + the fail-closed allow list
if (config) {
  const connectors = Array.isArray(config.connectors) ? config.connectors : []
  const allow = config.policy?.allowConnectors
  if (connectors.length === 0) {
    warn('Connectors', 'none configured', 'The gateway will start and expose no data. Add at least one connector.')
  } else {
    ok('Connectors', connectors.map((c) => `${c.name} (${c.type})`).join(', '))
    if (!Array.isArray(allow) || allow.length === 0) {
      fail(
        'policy.allowConnectors',
        `${connectors.length} connector(s) configured but the allow list is empty`,
        `Connectors are fail-closed: an empty list permits nothing. Add policy.allowConnectors: ${JSON.stringify(connectors.map((c) => c.name))}.`,
      )
    } else {
      const unknown = allow.filter((n) => !connectors.some((c) => c.name === n))
      const uncovered = connectors.filter((c) => !allow.includes(c.name)).map((c) => c.name)
      if (unknown.length) warn('policy.allowConnectors', `names with no connector: ${unknown.join(', ')}`, 'Typo, or a connector was removed.')
      if (uncovered.length) warn('policy.allowConnectors', `configured but not permitted: ${uncovered.join(', ')}`, 'These connectors will be refused at runtime.')
      if (!unknown.length && !uncovered.length) ok('policy.allowConnectors', allow.join(', '))
    }
  }

  // 4. Is anything actually being protected?
  const pol = config.policy || {}
  const hasMask = Array.isArray(pol.maskColumns) && pol.maskColumns.length > 0
  const hasDeny = Array.isArray(pol.denyTables) && pol.denyTables.length > 0
  const hasAllowTables = Array.isArray(pol.allowTables) && pol.allowTables.length > 0
  if (!hasMask && !hasDeny && !hasAllowTables) {
    warn(
      'Policy surface',
      'no maskColumns, no denyTables, no allowTables',
      'Content detectors (email / national id / card / secrets) still run, but no column or table rule is set. ' +
        'That is a valid choice — make sure it is a choice.',
    )
  } else {
    ok('Policy surface', [hasAllowTables && 'allowTables', hasDeny && 'denyTables', hasMask && 'maskColumns'].filter(Boolean).join(' + '))
  }

  // 4b. Raised maxRows — performance warning, not a deny.
  // Threshold is measured (docs/benchmarks/masking-cost-threshold.json).
  // Doctor does not import dist/; the number is read from that file, or 100.
  const thresholdPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'benchmarks', 'masking-cost-threshold.json')
  let warnAbove = 100
  try {
    if (existsSync(thresholdPath)) {
      const t = JSON.parse(readFileSync(thresholdPath, 'utf8'))
      if (Number.isFinite(t.warnAbove)) warnAbove = t.warnAbove
    }
  } catch { /* keep 100 */ }
  const maxRows = pol.maxRows
  if (typeof maxRows === 'number' && maxRows > warnAbove) {
    warn(
      'policy.maxRows',
      `maxRows is ${maxRows} (measured warning above ${warnAbove}). Masking cost grows with the number of distinct values this policy already masked, not with table size. The row cap bounds that set. The query is not rejected.`,
      'Leave the default if you do not need more rows. If you raise it, expect carry-over cost to grow with unique masked values.',
    )
  } else if (typeof maxRows === 'number') {
    ok('policy.maxRows', `maxRows is ${maxRows} (at or below the measured threshold ${warnAbove})`)
  } else {
    ok('policy.maxRows', `maxRows is 100 (default — policy.maxRows omitted; threshold ${warnAbove})`)
  }
  for (const [name, profile] of Object.entries(pol.profiles || {})) {
    const pMax = profile && typeof profile === 'object' ? profile.maxRows : undefined
    if (typeof pMax === 'number' && pMax > warnAbove) {
      warn(
        `policy.profiles.${name}.maxRows`,
        `profile maxRows is ${pMax} (measured warning above ${warnAbove}). Same cost: distinct masked values, not table size. Not rejected.`,
        'A profile can only raise the cap for one identified person. The cost still grows with unique masked values.',
      )
    }
  }

  // D2 — which SQL gate the query tool will use. Silence here was the bug.
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  let dialectInfo = null
  try {
    dialectInfo = resolveDoctorDialect(pol.dialect)
    ok('SQL dialect', dialectLine(dialectInfo.dialect, dialectInfo.source))
  } catch (e) {
    fail('SQL dialect', e.message, 'Set policy.dialect to postgres, mssql, or oracle. A typo does not become postgres.')
  }
  if (dialectInfo) {
    if (dialectInfo.dialect === 'postgres') {
      ok('SQL gate', 'postgres gate is built-in (Governance.guardQuery)')
    } else {
      const gateFile = join(pkgRoot, 'dist', 'sql-gate', `${dialectInfo.dialect}.js`)
      if (!existsSync(gateFile)) {
        fail(
          'SQL gate',
          `${dialectInfo.dialect} gate file is missing (dist/sql-gate/${dialectInfo.dialect}.js)`,
          'Run npm run build in the install. The query tool cannot load this dialect without that file.',
        )
      } else {
        try {
          await import(pathToFileURL(gateFile).href)
          ok('SQL gate', `${dialectInfo.dialect} gate loaded from dist/sql-gate/${dialectInfo.dialect}.js`)
        } catch (e) {
          fail(
            'SQL gate',
            `${dialectInfo.dialect} gate failed to load: ${e.name}`,
            'Rebuild the package. The query tool will fail closed on this dialect until the gate loads.',
          )
        }
      }
    }
  }

  // K6 — operator executor is not a silent empty schema.
  const customSql = connectors.filter((c) => c && c.type === 'custom-sql')
  if (customSql.length) {
    ok(
      'custom-sql',
      `${customSql.length} operator executor(s): ${customSql.map((c) => c.name).join(', ')}. Schema discovery is not implemented.`,
    )
    if (!pol.dialect) {
      fail(
        'custom-sql dialect',
        'custom-sql is configured but policy.dialect is omitted',
        'Declare policy.dialect (postgres, mssql, or oracle). The omitted-dialect postgres default does not apply.',
      )
    } else {
      ok('custom-sql dialect', `declared ${String(pol.dialect)}`)
    }
  }

  // D3 — custom PII: names only. Pattern text must never reach stdout.
  const patterns = Array.isArray(pol.customPatterns) ? pol.customPatterns : []
  const patternNames = patterns
    .map((p) => (p && typeof p.name === 'string' ? p.name : null))
    .filter(Boolean)
  if (patterns.length === 0) {
    ok('policy.customPatterns', '0 custom patterns')
  } else {
    const compilerPath = join(pkgRoot, 'dist', 'custom_patterns.js')
    if (!existsSync(compilerPath)) {
      unseen(
        'policy.customPatterns',
        `${patterns.length} named: ${patternNames.join(', ') || '(unnamed)'} — compile not checked (dist/custom_patterns.js missing)`,
        'Run npm run build. The gateway rejects a broken pattern at load; the doctor could not confirm that here.',
      )
    } else {
      try {
        const { compileCustomPatterns } = await import(pathToFileURL(compilerPath).href)
        compileCustomPatterns(patterns)
        ok('policy.customPatterns', `${patterns.length} compiled: ${patternNames.join(', ')}`)
      } catch (e) {
        fail(
          'policy.customPatterns',
          `${patterns.length} named: ${patternNames.join(', ') || '(unnamed)'} — compile failed (${e.name})`,
          'The gateway will refuse this config. Fix or remove the broken rule. Pattern text is not printed.',
        )
      }
    }
  }

  // 5. Per-person profiles need per-user credentials
  const profiles = pol.profiles || pol.actorProfiles
  if (profiles && Object.keys(profiles).length > 0) {
    if (envSet('CONARIUM_MCP_TOKEN')) {
      warn(
        'Masking profiles',
        'profiles are configured while a shared token is in use',
        'A profile only applies to a per-user credential. With a shared token every caller falls back to the base policy — ' +
          'the profiles are silently ignored.',
      )
    } else {
      ok('Masking profiles', `${Object.keys(profiles).length} profile(s)`)
    }
  }

  // 6. Receipts need an Ed25519 key
  const receiptSink = config.audit?.receiptSink
  const signingKeyPath = envSet('CONARIUM_AUDIT_SIGNING_KEY')
  if (receiptSink && !signingKeyPath) {
    fail(
      'Receipt signing key',
      'audit.receiptSink is configured but CONARIUM_AUDIT_SIGNING_KEY is not set',
      'Receipts require Ed25519 (HMAC is not sufficient). Set the key, or remove receiptSink.',
    )
  }

  // 7. Audit sink writability
  const sink = config.audit?.sink
  if (sink) {
    const sinkPath = resolve(process.cwd(), sink)
    const dir = dirname(sinkPath)
    if (!existsSync(dir)) {
      fail('Audit sink', `directory does not exist: ${dir}`, 'Create it, or point audit.sink somewhere that exists.')
    } else {
      try {
        accessSync(dir, constants.W_OK)
        ok('Audit sink', sinkPath + (existsSync(sinkPath) ? ` (${statSync(sinkPath).size} bytes)` : ' (will be created)'))
      } catch {
        fail('Audit sink', `directory is not writable: ${dir}`, 'The gateway is fail-closed on audit: it will refuse to serve.')
      }
    }
  }
}

// 7b. Production proof profile — one block
{
  const production =
    (process.env.CONARIUM_PROFILE || '').toLowerCase() === 'production' ||
    config?.profile === 'production'
  if (production) {
    const missing = []
    if (!envSet('CONARIUM_AUDIT_SIGNING_KEY')) missing.push('Ed25519 (CONARIUM_AUDIT_SIGNING_KEY)')
    if (!envSet('CONARIUM_AUDIT_HMAC_KEY')) missing.push('HMAC (CONARIUM_AUDIT_HMAC_KEY)')
    const rateRaw = process.env.CONARIUM_MCP_RATE_PER_MIN
    const rate = rateRaw === undefined || rateRaw === '' ? 60 : Number(rateRaw)
    if (missing.length) {
      fail(
        'Production profile',
        `refuses boot without ${missing.join(' and ')}`,
        'Production requires Ed25519 AND HMAC, G3 strict signatures, and an anchor sink. Rate limit defaults to 60/min unless CONARIUM_MCP_RATE_PER_MIN=0.',
      )
    } else {
      ok(
        'Production profile',
        `Ed25519 + HMAC required; G3 on; anchor on; rate ${Number.isFinite(rate) ? rate : 60}/min`,
      )
    }
  }
}

// 8. Signing key material — never printed, only described
{
  const keyPath = envSet('CONARIUM_AUDIT_SIGNING_KEY')
  const hmac = envSet('CONARIUM_AUDIT_HMAC_KEY')
  const unsigned = envSet('CONARIUM_AUDIT_UNSIGNED')
  if (!keyPath && !hmac && !unsigned) {
    warn(
      'Audit signing',
      'no CONARIUM_AUDIT_SIGNING_KEY, no CONARIUM_AUDIT_HMAC_KEY, no CONARIUM_AUDIT_UNSIGNED',
      'The audit writer refuses to write unsigned entries. Set one of the three before first use.',
    )
  }
  if (keyPath) {
    const resolved = resolve(process.cwd(), keyPath)
    if (!existsSync(resolved)) {
      fail('Signing key', `CONARIUM_AUDIT_SIGNING_KEY points at a missing file: ${resolved}`, 'Check the path. The value is read as a FILE path, not as key material.')
    } else {
      try {
        const pem = readFileSync(resolved, 'utf-8')
        const key = createPrivateKey(pem)
        if (key.asymmetricKeyType !== 'ed25519') {
          fail('Signing key', `expected Ed25519, found ${key.asymmetricKeyType}`, 'Generate an Ed25519 key pair.')
        } else {
          ok('Signing key', `Ed25519 private key at ${resolved}`)
        }
      } catch (e) {
        fail('Signing key', `unreadable or not a private key: ${e.message}`, 'The file must be a PEM-encoded Ed25519 private key.')
      }
    }
  }
}

// 9. Public keys used for verification need their .keyid sidecar.
//    Without it the verifier returns 13 for EVERY receipt — and the operator
//    blames the receipts, not the missing file.
{
  const trust = envSet('CONARIUM_AUDIT_TRUST_PUBKEYS')
  if (trust) {
    for (const p of trust.split(',').map((s) => s.trim()).filter(Boolean)) {
      const pubPath = resolve(process.cwd(), p)
      if (!existsSync(pubPath)) {
        fail('Trusted public key', `missing file: ${pubPath}`, 'Check CONARIUM_AUDIT_TRUST_PUBKEYS.')
        continue
      }
      try {
        const k = createPublicKey(readFileSync(pubPath, 'utf-8'))
        if (k.asymmetricKeyType !== 'ed25519') {
          fail('Trusted public key', `expected Ed25519 at ${pubPath}, got ${k.asymmetricKeyType}`, 'Use the matching Ed25519 public key.')
          continue
        }
      } catch (e) {
        fail('Trusted public key', `invalid PEM at ${pubPath}: ${e.message}`, 'Re-export the public key.')
        continue
      }
      const sidecar = `${pubPath}.keyid`
      if (!existsSync(sidecar)) {
        fail(
          'keyId sidecar',
          `missing: ${sidecar}`,
          'The verifier requires <pubkey>.keyid next to every trusted public key. Without it EVERY receipt fails with exit 13, ' +
            'which reads like tampering and is not.',
        )
      } else if (readFileSync(sidecar, 'utf-8').trim() === '') {
        fail('keyId sidecar', `empty: ${sidecar}`, 'It must contain the key id used when the receipts were signed.')
      } else {
        ok('Trusted public key', `${pubPath} (+ keyid sidecar)`)
      }
    }
  }
}

// 10. Anchoring uses the built-in calendar client (no extra package).
{
  const sink = (process.env.CONARIUM_ANCHOR_SINK || '').toLowerCase()
  const anchoring = Boolean(
    sink === 'opentimestamps' ||
      sink === 'ots' ||
      envSet('CONARIUM_ANCHOR_BASE_URL') ||
      envSet('CONARIUM_ANCHOR_STORE') ||
      config?.audit?.anchor,
  )
  if (anchoring) {
    ok(
      'Anchoring',
      'configured — built-in OpenTimestamps client (Node crypto + calendar HTTPS). No javascript-opentimestamps.',
    )
  }
}

// 11. Connector endpoints — described always, probed only when networking is on.
//     `--no-net` must silence the network, not the diagnosis: an operator on an
//     air-gapped box still needs to see which endpoint the config points at.
if (config) {
  const targets = []
  for (const c of Array.isArray(config.connectors) ? config.connectors : []) {
    const url = c?.config?.url
    if (typeof url !== 'string') continue
    const raw = url.startsWith('env:') ? process.env[url.slice(4)] : url
    if (!raw) {
      fail('Connector DSN', `${c.name}: config points at env ${url.slice(4)} which is not set`, 'Export the variable before starting the gateway.')
      continue
    }
    const d = describeDsn(raw)
    if (!d) {
      fail('Connector DSN', `${c.name}: value is not a parseable URL`, 'Expected e.g. postgresql://user:pass@host:5432/db')
      continue
    }
    // Always show WHICH endpoint was checked — an operator debugging a wrong
    // environment needs to see it, and it is the only line where a DSN is
    // rendered at all, so the redaction is exercised on every run (and by the
    // test suite) instead of only in the no-password branch.
    if (!d.hasPassword && d.user !== '(none)') {
      warn('Connector DSN', `${c.name}: ${d.text} — no password in the DSN`, 'Fine if you authenticate another way; surprising otherwise.')
    } else {
      ok('Connector DSN', `${c.name}: ${d.text}${d.hasPassword ? ' (password set, not shown)' : ''}`)
    }
    if (d.host && d.port) targets.push({ name: c.name, type: c.type, raw, ...d })
  }
  const reachable = []
  for (const t of SKIP_NET ? [] : targets) {
    const r = await tcpProbe(t.host, t.port)
    if (r.reachable) {
      ok('Reachability', `${t.name}: ${t.host}:${t.port} answers`)
      reachable.push(t)
    } else
      fail(
        'Reachability',
        `${t.name}: ${t.host}:${t.port} unreachable (${r.why})`,
        'The gateway logs connector failures and keeps running with zero connectors — it will look healthy and serve nothing.',
      )
  }

  // D1 — declared dialect vs the engine that actually answers.
  // Silence here meant Oracle rules on a Postgres DSN. Mismatch is FAIL.
  // Cannot ask → unseen. Never "probably matches".
  let dialectForEngine = null
  try {
    dialectForEngine = resolveDoctorDialect(config.policy?.dialect).dialect
  } catch {
    dialectForEngine = null
  }
  if (dialectForEngine) {
    let schemeConflict = false
    for (const t of targets) {
      const fromScheme = familyFromScheme(t.scheme)
      if (fromScheme && !dialectAgrees(dialectForEngine, fromScheme)) {
        schemeConflict = true
        fail(
          'Engine identity',
          `${t.name}: policy.dialect is ${dialectForEngine} but the DSN scheme is ${t.scheme} (${fromScheme})`,
          'The query tool will parse with one grammar and send the SQL to another engine. Point the DSN at the declared dialect, or change policy.dialect.',
        )
      }
    }
    if (schemeConflict) {
      // Already FAIL. Do not add a "not checked" line that reads like a second opinion.
    } else if (SKIP_NET) {
      unseen(
        'Engine identity',
        `not checked (--no-net). Declared dialect ${dialectForEngine} was not compared to a live engine.`,
        'Rerun without --no-net when the database is reachable. Do not assume the dialect matches.',
      )
    } else if (targets.length === 0) {
      unseen(
        'Engine identity',
        `not checked (no SQL DSN). Declared dialect ${dialectForEngine}.`,
        'Add a postgres / SQL connector URL, or ignore this if this install has no SQL engine.',
      )
    } else if (reachable.length === 0) {
      unseen(
        'Engine identity',
        `not checked (host unreachable). Declared dialect ${dialectForEngine}.`,
        'Bring the engine up, then rerun. Unreachable is not a match.',
      )
    } else {
      for (const t of reachable) {
        const id = await identifyEngine(t)
        if (!id) {
          unseen(
            'Engine identity',
            `${t.name}: ${t.host}:${t.port} answers TCP but the engine family could not be read. Declared ${dialectForEngine}.`,
            'Doctor asked the engine and got no version banner. Not a pass.',
          )
          continue
        }
        if (!dialectAgrees(dialectForEngine, id.family)) {
          fail(
            'Engine identity',
            `${t.name}: policy.dialect is ${dialectForEngine} but the engine identified as ${id.family} (${id.summary})`,
            'The query tool will enforce the wrong grammar against this engine. Fix policy.dialect or the DSN.',
          )
        } else {
          ok('Engine identity', `${t.name}: engine is ${id.family} — matches policy.dialect ${dialectForEngine}`)
        }
      }
    }
  }
}

// 12. License pack — offline, never fail-closed. A broken license file must
//     not lock the MIT core. Missing file = community.
{
  const licensePath = envSet('CONARIUM_LICENSE_FILE') || join(process.cwd(), 'conarium.license.json')
  const pubPath = envSet('CONARIUM_LICENSE_PUBKEY')
  if (!existsSync(licensePath)) {
    ok('License', 'community (no license file)')
  } else {
    let verifier = null
    try {
      verifier = await import('../dist/license.js')
    } catch {
      verifier = null
    }
    if (!verifier?.verifyLicense) {
      warn(
        'License',
        `file present at ${licensePath} but the verifier is not built`,
        'Run npm run build, or ignore this — the MIT core stays community either way.',
      )
    } else if (!pubPath) {
      warn(
        'License',
        `file present at ${licensePath} but CONARIUM_LICENSE_PUBKEY is not set — treating as community`,
        'Set the pubkey path to verify offline. Until then the MIT core stays community.',
      )
    } else if (!existsSync(pubPath)) {
      warn('License', `CONARIUM_LICENSE_PUBKEY points at a missing file — treating as community`, 'Check the path.')
    } else {
      const r = verifier.verifyLicense(readFileSync(licensePath, 'utf-8'), readFileSync(pubPath, 'utf-8'))
      if (r.valid) ok('License', `${r.tier}${r.customer ? ` · ${r.customer}` : ''}${r.expiresAt ? ` · expires ${r.expiresAt}` : ''}`)
      else ok('License', `community (${r.reason})`)
    }
  }
}

/* ------------------------------------------------------------------ report */

const ICON = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', unseen: 'unseen' }
console.log('')
console.log('conarium doctor')
console.log('─'.repeat(66))
for (const r of results) {
  console.log(`[${ICON[r.level]}] ${r.label}: ${r.detail}`)
  if (r.fix && r.level !== 'ok') console.log(`          → ${r.fix}`)
}
const fails = results.filter((r) => r.level === 'fail').length
const warns = results.filter((r) => r.level === 'warn').length
const unseenN = results.filter((r) => r.level === 'unseen').length
console.log('─'.repeat(66))
console.log(`${results.length} checks · ${fails} failed · ${warns} warning(s) · ${unseenN} unseen`)
if (fails === 0 && warns === 0 && unseenN === 0) console.log('This install is ready.')
if (fails === 0 && unseenN > 0) console.log('No failures. Unseen lines were not verified — not a pass.')
if (fails > 0) console.log('Fix the FAIL lines above; the gateway will not govern correctly until you do.')
console.log('')
// Set the code and let the loop drain. process.exit() here raced the closing
// probe sockets and aborted the process on Windows, which surfaced as 127 —
// a code this tool does not define, and one a deployment gate cannot read.
process.exitCode = fails > 0 ? 1 : 0
