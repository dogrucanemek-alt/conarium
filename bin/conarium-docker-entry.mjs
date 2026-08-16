#!/usr/bin/env node
/**
 * conarium-docker-entry — container entry point.
 *
 * Conarium refuses to start when it cannot sign audit entries. That rule is
 * deliberate and stays: an unsigned audit log cannot later be shown to be
 * unaltered, so writing one would be worse than refusing.
 *
 * The rule has a cost the image did not pay for. A container started with no
 * key mounted — a directory listing's health check, or anyone running the
 * image to see what the tools are — dies at boot before it can answer a single
 * introspection request. The refusal is right; the image was simply not
 * prepared for it.
 *
 * So: if no audit key is configured, mint a throwaway Ed25519 key inside the
 * container and say so on stderr. Entries are still signed — the rule is not
 * relaxed — but the key dies with the container and its keyId announces that.
 *
 * This file does nothing at all when a key, an HMAC key, or an explicit
 * CONARIUM_AUDIT_UNSIGNED=1 is already configured. Mount your own key and this
 * path is never taken.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeKeyPairFiles } from '../dist/keys.js'

const env = process.env

const configured =
  (env.CONARIUM_AUDIT_SIGNING_KEY ?? '') !== '' ||
  (env.CONARIUM_AUDIT_HMAC_KEY ?? '') !== '' ||
  (env.CONARIUM_AUDIT_UNSIGNED ?? '') !== ''

if (!configured) {
  const dir = env.CONARIUM_EPHEMERAL_KEY_DIR || join(tmpdir(), 'conarium-ephemeral')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const base = join(dir, 'audit-ed25519')

  // writeKeyPairFiles uses flag 'wx' — it will not clobber an existing key.
  // A restarted container that kept its tmpdir keeps the same key, which is
  // what we want: the audit chain stays verifiable across the restart.
  if (!existsSync(`${base}.pem`)) {
    // The keyId says what the key is. A verifier reading a receipt signed with
    // this key learns that it came from a throwaway container key, not from an
    // operator-held one.
    writeKeyPairFiles(base, `ephemeral-container-${randomBytes(4).toString('hex')}`)
  }

  env.CONARIUM_AUDIT_SIGNING_KEY = `${base}.pem`

  console.error(
    '[conarium] no audit key configured — minted an EPHEMERAL signing key at ' +
      `${base}.pem. Entries are signed, but this key is generated inside the ` +
      'container and is lost when it stops: receipts signed with it cannot be ' +
      'verified afterwards by anyone who did not keep the public key. For any ' +
      'real use, mount your own key and set CONARIUM_AUDIT_SIGNING_KEY.',
  )
}

await import('../dist/index.js')
