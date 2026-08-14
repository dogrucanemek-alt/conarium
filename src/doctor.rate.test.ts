/**
 * G12 — doctor names the HTTP rate limit.
 * Default 0 is unchanged (http.ts). Doctor must warn when HTTP is on and limit is 0.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'conarium-doctor.mjs')

const CFG = {
  connectors: [{ type: 'docs', name: 'docs', description: 'fixture', config: { path: './docs' } }],
  policy: { allowConnectors: ['docs'] },
}

function runDoctor(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-g12-'))
  writeFileSync(join(dir, 'conarium.config.json'), JSON.stringify(CFG))
  const r = spawnSync(process.execPath, [DOCTOR, '--no-net'], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CONARIUM_AUDIT_SIGNING_KEY: '',
      CONARIUM_AUDIT_HMAC_KEY: '',
      CONARIUM_AUDIT_TRUST_PUBKEYS: '',
      CONARIUM_AUDIT_UNSIGNED: '1',
      CONARIUM_MCP_TOKEN: '',
      CONARIUM_MCP_RATE_PER_MIN: '',
      CONARIUM_PROFILE: '',
      ...env,
    },
  })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

describe('G12 doctor HTTP rate-limit visibility', () => {
  it('HTTP + limit 0 is a warning, not a failure', () => {
    const { status, out } = runDoctor({ CONARIUM_MCP_TOKEN: 'dummy-token-not-a-secret' })
    expect(status).toBe(0)
    expect(out).toMatch(/\[ warn \].*HTTP rate limit/i)
    expect(out).toMatch(/0/)
    expect(out).not.toContain('dummy-token-not-a-secret')
  })

  it('HTTP + limit > 0 is an info line', () => {
    const { status, out } = runDoctor({
      CONARIUM_MCP_TOKEN: 'dummy-token-not-a-secret',
      CONARIUM_MCP_RATE_PER_MIN: '60',
    })
    expect(status).toBe(0)
    expect(out).toMatch(/\[  ok  \].*HTTP rate limit/i)
    expect(out).toMatch(/60/)
    expect(out).not.toMatch(/\[ warn \].*HTTP rate limit/i)
    expect(out).not.toContain('dummy-token-not-a-secret')
  })
})
