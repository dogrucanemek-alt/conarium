/**
 * parseConariumConfig must accept the policy fields Governance already honours.
 * 2026-08-13: profiles / actorProfiles / maskLabelledNames lived on the type
 * and in README, and tests constructed Governance by hand — but loadConfig()
 * went through a strict Zod schema that rejected those keys. A profiled
 * conarium.config.json could not boot the gateway. The feature existed only
 * in unit tests.
 */
import { describe, it, expect } from 'vitest'
import { parseConariumConfig } from './config.js'

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
