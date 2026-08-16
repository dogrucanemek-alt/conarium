/**
 * R2 kapısı: disclosure alanı, doğrulama-kehaneti sınırı iki dilde yazılmadan
 * duramaz. Bu test o cümleleri kilitler.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('LIMITATIONS — disclosure oracle + destination declaration', () => {
  const en = readFileSync(join(root, 'LIMITATIONS.md'), 'utf8')
  const tr = readFileSync(join(root, 'LIMITATIONS.tr.md'), 'utf8')

  it('EN names the verification oracle and that a nonce does not close it', () => {
    expect(en).toMatch(/verification oracle/i)
    expect(en).toMatch(/nonce does not close it/i)
    expect(en).toMatch(/Destination is a declaration, not a verification/)
    expect(en).not.toMatch(/destination is verified/i)
  })

  it('TR names the same limits', () => {
    expect(tr).toMatch(/doğrulama kehaneti/)
    expect(tr).toMatch(/Nonce kapatmaz/)
    expect(tr).toMatch(/Hedef beyandır, doğrulanmaz/)
    expect(tr).not.toMatch(/hedef doğrulanır/)
  })
})
