#!/usr/bin/env node
/**
 * The container entry point must survive an empty environment.
 *
 * Conarium refuses to start without an audit signing key. That is correct.
 * The consequence nobody ran into: a bare container — a directory's health
 * check, or anyone running the image to see what the tools are — died at boot
 * before answering a single MCP request. Every test in the suite either sets a
 * key or reads source, so no test covered the one path a stranger takes first.
 *
 * Two things are asserted here:
 *   1. with nothing configured, the server boots and answers tools/list
 *   2. with a key already configured, the entry script mints nothing
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(root, 'bin', 'conarium-docker-entry.mjs')

const MCP_HANDSHAKE = [
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'directory-check', version: '1.0' },
    },
  }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  // Trailing newline is load-bearing: the transport is line-delimited, so a
  // final request without one is never seen as a complete line.
  '',
].join('\n')

/** Run the entry the way a stranger's container does: no env, no config, empty cwd. */
function runEntry(extraEnv) {
  const env = { ...process.env }
  // Strip anything the developer's shell may already carry — the point of this
  // test is the environment a stranger's container has, not ours.
  delete env.CONARIUM_AUDIT_SIGNING_KEY
  delete env.CONARIUM_AUDIT_HMAC_KEY
  delete env.CONARIUM_AUDIT_UNSIGNED
  delete env.CONARIUM_AUDIT_KEY_ID
  // cwd matters as much as env: run from the repo root and the server finds the
  // developer's conarium.config.json, which no container has. Run from an empty
  // directory or this test proves less than it appears to.
  return spawnSync(process.execPath, [ENTRY], {
    input: MCP_HANDSHAKE,
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: mkdtempSync(join(tmpdir(), 'conarium-bare-cwd-')),
    env: { ...env, ...extraEnv },
  })
}

// ── 1. bare container: boots, signs, and answers ────────────────────────────

const keyDir = join(mkdtempSync(join(tmpdir(), 'conarium-docker-entry-')), 'keys')
const bare = runEntry({ CONARIUM_EPHEMERAL_KEY_DIR: keyDir })

assert.equal(bare.status, 0, `entry must exit 0 with nothing configured, got ${bare.status}\n${bare.stderr}`)
assert.match(bare.stdout, /"tools"/, 'entry must answer tools/list')
assert.match(bare.stdout, /"name":"query"/, 'the query tool must be listed')
assert.match(bare.stderr, /EPHEMERAL signing key/, 'an ephemeral key must be announced, not applied silently')
assert.match(bare.stderr, /mount your own key/i, 'the warning must say what to do instead')

// The rule is not relaxed: a real key exists and carries the sidecar the
// verifier needs. UNSIGNED is never set on our behalf.
assert.ok(existsSync(join(keyDir, 'audit-ed25519.pem')), 'a private key must be written')
assert.ok(existsSync(join(keyDir, 'audit-ed25519.pem.keyid')), 'the .keyid sidecar must be written')
assert.doesNotMatch(bare.stderr, /CONARIUM_AUDIT_UNSIGNED=1 —/, 'must not fall back to unsigned entries')

// The keyId says what the key is, so a receipt signed with it is self-describing.
const keyId = readFileSync(join(keyDir, 'audit-ed25519.pem.keyid'), 'utf-8').trim()
assert.match(keyId, /^ephemeral-container-/, `keyId must announce itself, got "${keyId}"`)

// ── 2. key already configured: the entry mints nothing ──────────────────────

const untouched = join(mkdtempSync(join(tmpdir(), 'conarium-docker-entry-')), 'keys')
const configured = runEntry({
  CONARIUM_EPHEMERAL_KEY_DIR: untouched,
  CONARIUM_AUDIT_UNSIGNED: '1',
})

assert.equal(configured.status, 0, `entry must exit 0 when audit is configured, got ${configured.status}`)
assert.doesNotMatch(configured.stderr, /EPHEMERAL signing key/, 'must stay out of the way when configured')
assert.ok(
  !existsSync(untouched) || readdirSync(untouched).length === 0,
  'a configured container must not have a key minted behind its back',
)

console.log('PASS docker_entry: bare container boots and answers; configured container is untouched')
