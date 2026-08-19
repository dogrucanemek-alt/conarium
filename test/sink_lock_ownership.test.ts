/**
 * A lock file is created and then filled. Between those two syscalls another
 * process sees the file exist with an empty body, so it cannot read an owner
 * pid. "Owner unknown" is not "owner gone": stealing there hands the same sink
 * to two live writers, which is the fork that `receipt_sink_lock.test.ts`
 * catches only when the race happens to land inside that window.
 *
 * These cases plant the lock file directly, so the window is not raced for —
 * it is stated. Age is the only signal that separates mid-creation from a
 * process that died before it could write its pid, so age is what decides.
 */
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Audit } from '../src/audit.ts'

const ENV_UNSIGNED = 'CONARIUM_AUDIT_UNSIGNED'
const PREV_UNSIGNED = process.env[ENV_UNSIGNED]
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'conarium-lock-own-'))
  // These cases are about who may hold the lock, not about signing.
  process.env[ENV_UNSIGNED] = '1'
})

afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env[ENV_UNSIGNED]
  else process.env[ENV_UNSIGNED] = PREV_UNSIGNED
  // Directories under tmpdir are reaped by the OS; nothing to unwind here.
})

const sinkFor = (name: string): string => join(dir, `${name}.jsonl`)

describe('sink lock ownership', () => {
  it('refuses a lock whose owner cannot be read and which is still fresh', () => {
    const sink = sinkFor('fresh-unknown')
    const lockPath = `${sink}.lock`
    // Exactly what a reader sees between open(wx) and the body write.
    writeFileSync(lockPath, '', { mode: 0o600 })

    expect(() => new Audit({ sink })).toThrow(/another process holds/)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('reclaims an unreadable lock once it is older than the stale threshold', () => {
    const sink = sinkFor('aged-unknown')
    const lockPath = `${sink}.lock`
    writeFileSync(lockPath, '', { mode: 0o600 })
    // A process that died between creating the lock and writing its pid would
    // otherwise wedge this sink forever, and the gateway is fail-closed.
    const longAgo = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(lockPath, longAgo, longAgo)

    const audit = new Audit({ sink })
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid)
    audit.close()
  })

  it('still reclaims a lock held by a pid that is no longer alive', () => {
    const sink = sinkFor('dead-owner')
    const lockPath = `${sink}.lock`
    // 0x7FFFFFFF is above every reachable pid on Linux and Windows alike.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 0x7fffffff, startedAt: 1 })}\n`, { mode: 0o600 })

    const audit = new Audit({ sink })
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid)
    audit.close()
  })
})
