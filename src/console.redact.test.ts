/**
 * G19 — console config redaction must catch anonKey / headers / JWT-shaped values.
 */
import { describe, expect, it } from 'vitest'
import { redactSecretFields } from './console.js'

describe('G19 — console secret redaction', () => {
  it('redacts anonKey and Authorization headers', () => {
    const out = redactSecretFields({
      connectors: [{
        name: 'sb',
        config: {
          anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
          key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
          headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' },
          keyboard: 'not-a-secret',
        },
      }],
    }) as { connectors: Array<{ config: Record<string, unknown> }> }
    const cfg = out.connectors[0].config
    expect(cfg.anonKey).toBe('[REDACTED]')
    expect(cfg.key).toBe('[REDACTED]')
    expect(cfg.headers).toBe('[REDACTED]')
    expect(cfg.keyboard).toBe('not-a-secret')
  })

  it('redacts JWT-shaped values even under an innocent key', () => {
    const out = redactSecretFields({
      note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signaturexx',
    }) as { note: string }
    expect(out.note).toBe('[REDACTED]')
  })
})
