import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

function sinkPath() {
  return join(mkdtempSync(join(tmpdir(), 'conarium-g5-')), 'audit.jsonl')
}

describe('G5 — multi-process audit sink lock', () => {
  it('a live foreign PID holding <sink>.lock rejects the second writer', async () => {
    const sink = sinkPath()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      stdio: 'ignore',
    })
    try {
      writeFileSync(`${sink}.lock`, JSON.stringify({ pid: child.pid, startedAt: Date.now() }) + '\n')
      expect(() => new Audit({ sink, consumer: 'g5' })).toThrow(
        /another process holds the audit sink lock \(pid /,
      )
    } finally {
      child.kill()
    }
  })

  it('a stale lock (dead PID) is stolen and a single instance still writes', () => {
    const sink = sinkPath()
    writeFileSync(`${sink}.lock`, JSON.stringify({ pid: 2147483646, startedAt: 0 }) + '\n')
    const audit = new Audit({ sink, consumer: 'g5' })
    expect(() => audit.log({ tool: 'ok', denied: false })).not.toThrow()
    expect(existsSync(sink)).toBe(true)
    audit.close()
    expect(existsSync(`${sink}.lock`)).toBe(false)
  })

  it('same-process second Audit is re-entrant (console / validateChain boot)', () => {
    const sink = sinkPath()
    const a = new Audit({ sink, consumer: 'A' })
    a.log({ tool: 't1', denied: false })
    const b = new Audit({ sink, consumer: 'B' })
    b.log({ tool: 't2', denied: false })
    a.close()
    b.close()
  })
})
