import { describe, expect, it, vi } from 'vitest'
import { assertPrivateKeyMode } from './keys.js'

describe('G9 key permissions fail-closed', () => {
  it('0644 throws on POSIX; win32 is skipped', () => {
    expect(() => assertPrivateKeyMode('/tmp/k.pem', 0o644, { platform: 'linux' })).toThrow(/0600/)
    expect(() => assertPrivateKeyMode('/tmp/k.pem', 0o644, { platform: 'win32' })).not.toThrow()
  })

  it('CONARIUM_ALLOW_LOOSE_KEY_PERMS=1 returns to warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      assertPrivateKeyMode('/tmp/k.pem', 0o644, { platform: 'linux', allowLoose: true }),
    ).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('0600 is accepted', () => {
    expect(() => assertPrivateKeyMode('/tmp/k.pem', 0o600, { platform: 'linux' })).not.toThrow()
  })
})
