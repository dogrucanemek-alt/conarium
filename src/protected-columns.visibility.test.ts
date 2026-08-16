/**
 * P4 — a protected-column denial is visible on the receipt and in doctor.
 * Schema string is conarium-receipt/0.4; flags is already a free string list.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Governance, PolicyError } from './governance.js'

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'conarium-doctor.mjs')

describe('P4 protectedColumns visibility', () => {
  it('PolicyError metadata carries protected-column-denied (no values)', () => {
    const gov = new Governance({
      allowTables: ['public.customers'],
      protectedColumns: ['*.email'],
    })
    try {
      gov.guardQuery("SELECT id FROM public.customers WHERE email LIKE 'a%'")
      expect.fail('expected PolicyError')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError)
      const meta = (err as PolicyError).metadata
      expect(meta?.denied).toBe(true)
      expect(meta?.flags).toContain('protected-column-denied')
      expect(JSON.stringify(meta)).not.toMatch(/@|4111|tckn/i)
    }
  })

  it('doctor summary names protectedColumns when the field is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-prot-doc-'))
    writeFileSync(
      join(dir, 'conarium.config.json'),
      JSON.stringify({
        connectors: [{ type: 'docs', name: 'docs', description: 'fixture', config: { path: './docs' } }],
        policy: {
          allowConnectors: ['docs'],
          allowTables: ['docs.note'],
          maskColumns: ['*.phone'],
          protectedColumns: ['*.email', 'customers.tckn'],
        },
      }),
    )
    const r = spawnSync(process.execPath, [DOCTOR, '--no-net'], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CONARIUM_AUDIT_SIGNING_KEY: '',
        CONARIUM_AUDIT_HMAC_KEY: '',
        CONARIUM_AUDIT_TRUST_PUBKEYS: '',
        CONARIUM_MCP_TOKEN: '',
        CONARIUM_PROFILE: '',
      },
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    expect(out).toMatch(/protectedColumns/)
    expect(out).toMatch(/\*\.email/)
    expect(out).toMatch(/customers\.tckn/)
  })
})
