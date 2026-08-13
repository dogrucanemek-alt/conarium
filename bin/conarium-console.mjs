#!/usr/bin/env node
/**
 * conarium-console — the governance console, as a command.
 *
 * WHY THIS FILE EXISTS
 * The console has shipped inside the package since 0.1.0 and the pricing page
 * lists it, but nothing could start it: no bin entry, and the gateway never
 * launches it. Installed users had one way to choose what gets masked — hand
 * editing conarium.config.json. A feature you cannot reach is a feature you do
 * not have.
 *
 * WHAT IT IS
 * A local web UI over the policy: which tables are reachable, which columns are
 * masked, the row cap. It edits the rules that protect production data, so the
 * defaults here are deliberately strict:
 *
 * - Binds 127.0.0.1. Editing a security policy over a network interface is a
 *   different product with a different threat model.
 * - Refuses to start without CONARIUM_CONSOLE_TOKEN. The app already answers
 *   503 per request without it; failing at startup names the problem once
 *   instead of once per request.
 * - Binding anywhere other than loopback requires CONARIUM_CONSOLE_PUBLIC=1.
 *   Absence of configuration is not a decision to be reachable — the same rule
 *   the chat proxy learned the hard way.
 *
 * Exit codes follow the doctor's convention, outside the receipt namespace:
 *   0 = clean shutdown · 2 = could not start
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const valueOf = (f, fallback) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback
}

if (has('--help') || has('-h')) {
  console.log(`conarium-console — edit the policy without hand-editing JSON

  --config <p>  policy file to edit (default: conarium.config.json in cwd —
                the same file the gateway reads)
  --port <n>    default 3000 (or CONARIUM_CONSOLE_PORT)
  --host <ip>   default 127.0.0.1 (or CONARIUM_CONSOLE_HOST)
  --help        this text

Required:
  CONARIUM_CONSOLE_TOKEN        bearer token for every request
Optional:
  CONARIUM_CONSOLE_CSRF_TOKEN   defaults to the console token
  CONARIUM_CONSOLE_RATE_PER_MIN default 60, 0 disables
  CONARIUM_CONSOLE_PUBLIC=1     required to bind a non-loopback address

Exit: 0 clean shutdown · 2 could not start`)
  process.exit(0)
}

const die = (code, msg, fix) => {
  console.error(`conarium-console: ${msg}`)
  if (fix) console.error(`  → ${fix}`)
  process.exit(code)
}

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const consoleJs = join(pkgRoot, 'dist', 'console.js')
if (!existsSync(consoleJs)) {
  die(
    2,
    `the compiled console is missing (${consoleJs})`,
    'Running from a source checkout? Build it first: npm run build',
  )
}

if (!process.env.CONARIUM_CONSOLE_TOKEN?.trim()) {
  die(
    2,
    'CONARIUM_CONSOLE_TOKEN is not set',
    'This console edits the rules that protect production data; it will not run unauthenticated. ' +
      'Generate one and export it, e.g. node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"',
  )
}

// The console builds an audit writer at startup, and the audit writer refuses to
// write unsigned entries. That refusal is correct — but raw it surfaces as a
// stack trace from dist/audit.js, which tells the operator nothing about what to
// do. Name the variable here instead, and point at the command that creates one.
if (
  !process.env.CONARIUM_AUDIT_SIGNING_KEY?.trim() &&
  !process.env.CONARIUM_AUDIT_HMAC_KEY?.trim() &&
  !process.env.CONARIUM_AUDIT_UNSIGNED?.trim()
) {
  die(
    2,
    'no audit signing configuration (CONARIUM_AUDIT_SIGNING_KEY / CONARIUM_AUDIT_HMAC_KEY / CONARIUM_AUDIT_UNSIGNED)',
    'The console runs governed queries and every one of them is audited; the audit writer will not emit unsigned ' +
      'entries. `conarium-init` generates an Ed25519 key — export CONARIUM_AUDIT_SIGNING_KEY to point at it.',
  )
}

const host = valueOf('--host', process.env.CONARIUM_CONSOLE_HOST || '127.0.0.1')
const port = Number(valueOf('--port', process.env.CONARIUM_CONSOLE_PORT || '3000'))
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  die(2, `--port must be a valid port, got ${valueOf('--port', '')}`)
}

const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
if (!loopback && process.env.CONARIUM_CONSOLE_PUBLIC !== '1') {
  die(
    2,
    `refusing to bind ${host}: that is not loopback`,
    'A policy editor on a network interface is a different threat model. If you mean it, set ' +
      'CONARIUM_CONSOLE_PUBLIC=1 and put TLS and an allow list in front of it.',
  )
}

// pathToFileURL, not the bare path: on Windows an absolute path is not a valid
// ESM specifier ("Received protocol 'c:'") and the command dies before listening.
// Which config does it edit? `startConsole()` defaults to the copy shipped
// inside the package, which for an installed user is the wrong file twice over:
// it is not the one the gateway reads, and npm overwrites it on every install.
// Default to the same path the gateway uses — conarium.config.json in cwd.
const configFile = resolve(process.cwd(), valueOf('--config', 'conarium.config.json'))
if (!existsSync(configFile)) {
  die(
    2,
    `no config at ${configFile}`,
    'Run `conarium-init` first, or pass --config <path> to point at an existing one.',
  )
}

try {
  const { createConsoleApp } = await import(pathToFileURL(consoleJs).href)
  const app = createConsoleApp({ configFile })
  app.listen(port, host, () => {
    console.error(`[conarium-console] http://${host}:${port} — editing ${configFile}`)
    console.error(
      loopback
        ? '[conarium-console] loopback only — tunnel in over SSH if you are not on this machine'
        : '[conarium-console] WARNING: bound to a non-loopback address on purpose (CONARIUM_CONSOLE_PUBLIC=1)',
    )
  })
} catch (e) {
  // Anything that goes wrong before we are listening is a start failure, not a
  // crash the operator should have to read a stack trace to understand.
  die(2, `could not start: ${e.message}`)
}
