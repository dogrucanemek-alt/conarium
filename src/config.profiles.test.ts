/**
 * parseConariumConfig must accept the policy fields Governance already honours.
 * 2026-08-13: profiles / actorProfiles / maskLabelledNames lived on the type
 * and in README, and tests constructed Governance by hand — but loadConfig()
 * went through a strict Zod schema that rejected those keys. A profiled
 * conarium.config.json could not boot the gateway. The feature existed only
 * in unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConariumConfig, enforceProductionProfile, resolveHttpRatePerMin } from './config.js'

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'conarium-doctor.mjs')

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

describe('parseConariumConfig — profiles survive loadConfig', () => {
  it('accepts profiles, actorProfiles and maskLabelledNames and keeps them', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: {
        allowConnectors: ['docs'],
        allowTables: ['docs.note'],
        maskColumns: ['*.email'],
        maskLabelledNames: true,
        profiles: {
          patron: { maskColumns: ['*.email'], maskLabelledNames: false, maxRows: 20 },
        },
        actorProfiles: { emekcan: 'patron' },
      },
    })
    expect(cfg.policy?.profiles?.patron?.maskLabelledNames).toBe(false)
    expect(cfg.policy?.profiles?.patron?.maxRows).toBe(20)
    expect(cfg.policy?.actorProfiles?.emekcan).toBe('patron')
    expect(cfg.policy?.maskLabelledNames).toBe(true)
  })

  it('a profile that omits maskColumns does not get an empty array stuffed in', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: {
        maskColumns: ['*.email'],
        profiles: { patron: { maskLabelledNames: false } },
      },
    })
    expect(cfg.policy?.profiles?.patron?.maskColumns).toBeUndefined()
  })

  it('rejects a profile field that would widen reach (allowTables)', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: {
          profiles: { patron: { allowTables: ['*'] } },
        },
      }),
    ).toThrow(/Unrecognized key/)
  })
})

describe('G4 production proof profile', () => {
  const prev: Record<string, string | undefined> = {}
  const KEYS = [
    'CONARIUM_PROFILE',
    'CONARIUM_AUDIT_SIGNING_KEY',
    'CONARIUM_AUDIT_HMAC_KEY',
    'CONARIUM_AUDIT_REQUIRE_SIG',
    'CONARIUM_ANCHOR_SINK',
    'CONARIUM_MCP_RATE_PER_MIN',
  ]

  beforeEach(() => {
    for (const k of KEYS) {
      prev[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })

  it('refuses boot when Ed25519 or HMAC is missing', () => {
    process.env.CONARIUM_PROFILE = 'production'
    expect(() => enforceProductionProfile({})).toThrow(/CONARIUM_AUDIT_SIGNING_KEY/)
    process.env.CONARIUM_AUDIT_SIGNING_KEY = 'x.pem'
    expect(() => enforceProductionProfile({})).toThrow(/CONARIUM_AUDIT_HMAC_KEY/)
  })

  it('opens when both keys are set and turns G3 + anchor on', () => {
    process.env.CONARIUM_AUDIT_SIGNING_KEY = 'x.pem'
    process.env.CONARIUM_AUDIT_HMAC_KEY = 'hmac-secret'
    enforceProductionProfile({ profile: 'production' })
    expect(process.env.CONARIUM_AUDIT_REQUIRE_SIG).toBe('1')
    expect(process.env.CONARIUM_ANCHOR_SINK).toBe('opentimestamps')
  })

  it('stderr announces only the production defaults the operator did not set', () => {
    process.env.CONARIUM_AUDIT_SIGNING_KEY = 'x.pem'
    process.env.CONARIUM_AUDIT_HMAC_KEY = 'hmac-secret'
    const err: string[] = []
    const out: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      out.push(String(chunk))
      return origOut(chunk as string, ...(rest as []))
    }) as typeof process.stdout.write
    try {
      enforceProductionProfile({ profile: 'production' })
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
    }
    const stderr = err.join('')
    expect(stderr).toMatch(
      /\[conarium\] production profile: enabling CONARIUM_AUDIT_REQUIRE_SIG=1/,
    )
    expect(stderr).toMatch(
      /\[conarium\] production profile: anchor sink not set → enabling opentimestamps \(outbound HTTPS to public calendars\)/,
    )
    expect(out.join('')).not.toMatch(/production profile/)
  })

  it('stderr stays quiet when the operator already set the production defaults', () => {
    process.env.CONARIUM_AUDIT_SIGNING_KEY = 'x.pem'
    process.env.CONARIUM_AUDIT_HMAC_KEY = 'hmac-secret'
    process.env.CONARIUM_AUDIT_REQUIRE_SIG = '1'
    process.env.CONARIUM_ANCHOR_SINK = 'opentimestamps'
    const err: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      enforceProductionProfile({ profile: 'production' })
    } finally {
      process.stderr.write = origErr
    }
    expect(err.join('')).not.toMatch(/production profile/)
  })

  it('parseConariumConfig accepts profile production', () => {
    const cfg = parseConariumConfig({ ...BASE, profile: 'production' })
    expect(cfg.profile).toBe('production')
  })

  it('rate limit is 60 unless explicitly 0', () => {
    expect(resolveHttpRatePerMin({ profile: 'production' })).toBe(60)
    process.env.CONARIUM_MCP_RATE_PER_MIN = '0'
    expect(resolveHttpRatePerMin({ profile: 'production' })).toBe(0)
    delete process.env.CONARIUM_MCP_RATE_PER_MIN
    expect(resolveHttpRatePerMin({})).toBe(0)
  })

  it('doctor reports production profile as one FAIL block when keys are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-g4-'))
    writeFileSync(
      join(dir, 'conarium.config.json'),
      JSON.stringify({
        ...BASE,
        profile: 'production',
        policy: { allowConnectors: ['docs'] },
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
    expect(r.status).toBe(1)
    expect(out).toMatch(/Production profile/)
    expect(out).toMatch(/Ed25519/)
    expect(out).toMatch(/HMAC/)
  })
})
