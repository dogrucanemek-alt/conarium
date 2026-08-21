#!/usr/bin/env node
/**
 * conarium-init — write a fail-closed skeleton so the operator does not
 * copy config, MCP JSON and a key pair by hand (and forget the .keyid sidecar).
 *
 * Standalone: Node builtins only. No imports from src/ or dist/.
 *
 * Exit: 0 wrote · 1 refused (exists / cannot write) · 2 could not run
 * Secrets never go to stdout — paths only, never PEM bodies.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const valueOf = (f, fallback) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback
}

if (has('--help') || has('-h')) {
  console.log(`conarium-init — write a fail-closed Conarium skeleton

  --out <dir>   destination (default: current directory)
  --force       overwrite existing files
  --no-keys     skip the Ed25519 key pair
  --help        this text

Exit: 0 wrote · 1 refused · 2 could not run
Signing-key material is never printed — only its path.`)
  process.exit(0)
}

const OUT = resolve(process.cwd(), valueOf('--out', '.'))
const FORCE = has('--force')
const NO_KEYS = has('--no-keys')

const CONFIG_NAME = 'conarium.config.json'
const KEY_BASE = 'audit-ed25519'
const SIGNING_NAME = `${KEY_BASE}.pem`
const PUBLIC_NAME = `${KEY_BASE}.pub.pem`

function die(code, msg) {
  console.error(msg)
  process.exit(code)
}

function keyIdFromPublicPem(publicPem) {
  return createHash('sha256').update(publicPem.trim(), 'utf8').digest('hex').slice(0, 16)
}

const SKELETON = {
  serverName: 'Conarium',
  consumer: 'ai-assistant',
  connectors: [
    {
      type: 'postgres',
      name: 'maindb',
      description: 'Replace the URL with your read-only DSN before going live.',
      config: {
        url: 'postgresql://app:changeme@127.0.0.1:5432/yourdb',
      },
    },
  ],
  policy: {
    allowConnectors: ['maindb'],
    allowTables: [],
    denyTables: ['public.secrets', 'public.credit_cards'],
    maskColumns: ['*.email', '*.phone', '*.tckn', '*.iban', '*.ssn', '*.national_id'],
    maxRows: 50,
  },
  audit: {
    sink: 'conarium-audit.jsonl',
    failClosed: true,
  },
}

try {
  mkdirSync(OUT, { recursive: true })
} catch (e) {
  die(2, `cannot create ${OUT}: ${e.message}`)
}

const configPath = join(OUT, CONFIG_NAME)
const signingKeyPath = join(OUT, SIGNING_NAME)
const publicPath = join(OUT, PUBLIC_NAME)
const signingKeyIdPath = `${signingKeyPath}.keyid`
const publicKeyIdPath = `${publicPath}.keyid`

const planned = [configPath]
if (!NO_KEYS) planned.push(signingKeyPath, publicPath, signingKeyIdPath, publicKeyIdPath)

if (!FORCE) {
  const clashes = planned.filter((p) => existsSync(p))
  if (clashes.length) {
    die(1, `refusing to overwrite (pass --force):\n  ${clashes.join('\n  ')}`)
  }
}

const writeOpts = FORCE ? { encoding: 'utf-8' } : { encoding: 'utf-8', flag: 'wx' }

const config = structuredClone(SKELETON)
if (!NO_KEYS) {
  // Receipts need Ed25519. Writing receiptSink without a key makes the doctor
  // FAIL (not warn) — so this field only appears when we also write the pair.
  config.audit.receiptSink = 'conarium-receipts.jsonl'
}

try {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', writeOpts)
} catch (e) {
  die(1, `cannot write ${configPath}: ${e.code || e.message}`)
}

let keyId = null
if (!NO_KEYS) {
  const pair = generateKeyPairSync('ed25519')
  const signingPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  keyId = keyIdFromPublicPem(publicPem)
  try {
    writeFileSync(signingKeyPath, signingPem, { ...writeOpts, mode: 0o600 })
    writeFileSync(publicPath, publicPem, writeOpts)
    writeFileSync(signingKeyIdPath, keyId + '\n', writeOpts)
    writeFileSync(publicKeyIdPath, keyId + '\n', writeOpts)
  } catch (e) {
    die(1, `cannot write key files: ${e.code || e.message}`)
  }
  if (platform() !== 'win32') {
    try {
      chmodSync(signingKeyPath, 0o600)
    } catch {
      // best-effort; doctor will still accept the key
    }
  }
}

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gatewayJs = join(pkgRoot, 'dist', 'index.js')

console.log('')
console.log('conarium init')
console.log('─'.repeat(66))
console.log(`wrote  ${configPath}`)
console.log('        allowTables is empty on purpose — add schema-qualified')
console.log('        names (public.customers) or the gateway will deny every table.')
console.log('        maskColumns and denyTables are already set. Replace the')
console.log('        postgres URL before going live (placeholder DSN).')
if (!NO_KEYS) {
  console.log(`wrote  ${signingKeyPath}  (Ed25519, mode 0600 where supported)`)
  console.log(`wrote  ${publicPath}`)
  console.log(`wrote  ${publicKeyIdPath}  (keyId ${keyId})`)
  console.log(`wrote  ${signingKeyIdPath}`)
}
console.log('')
console.log('Next:')
if (!NO_KEYS) {
  console.log(`  export CONARIUM_AUDIT_SIGNING_KEY=${signingKeyPath}`)
  console.log(`  export CONARIUM_AUDIT_TRUST_PUBKEYS=${publicPath}`)
}
// --config is ALWAYS printed. The previous form printed 'conarium-doctor --no-net',
// which FAILED whenever `--out <dir>` was used: the config is written under <dir>
// while doctor looks in the cwd. A tool whose own printed command fails is a direct
// breach of the requirement that anyone can install this without asking us.
console.log(`  conarium-doctor --config ${configPath} --no-net`)
console.log('')
console.log('MCP client block (Cursor / Claude Code) — paste into mcp.json:')
console.log(JSON.stringify({
  mcpServers: {
    conarium: {
      command: 'node',
      // The config path is given EXPLICITLY: an MCP client starts the server in
      // ITS OWN working directory, not the user's install directory. Without the
      // path the gateway does not find the config and does NOT error — it comes up
      // with zero connectors, so nothing is governed at all. Doctor's "Config file:
      // not found" warning says exactly that, and we fell into the same trap once
      // while producing the walkthrough.
      args: [gatewayJs, '--config', configPath],
      env: NO_KEYS
        ? {}
        : { CONARIUM_AUDIT_SIGNING_KEY: signingKeyPath },
    },
  },
}, null, 2))
console.log('')
process.exit(0)
