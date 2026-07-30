import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTokenStore, resolveActor } from './tokens.js'

function tokenFile(entries: { token: string; id: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-tok-'))
  const p = join(dir, 'conarium.tokens.json')
  writeFileSync(p, JSON.stringify({
    tokens: entries.map(e => ({
      sha256: createHash('sha256').update(e.token).digest('hex'),
      id: e.id,
    })),
  }))
  return p
}

describe('token deposu', () => {
  it('dosya yoksa null döner — kişi bazlı kimlik kapalıdır, hata değil', () => {
    expect(loadTokenStore(join(tmpdir(), 'cnr-yok-' + Date.now() + '.json'))).toBeNull()
  })

  it('eşleşen token kişiyi çözer ve per-user-token olarak işaretler', () => {
    const store = loadTokenStore(tokenFile([{ token: 'tok-ayse', id: 'ayse@sirket.com' }]))
    const a = resolveActor('tok-ayse', store, 'conarium_c2')
    expect(a).toEqual({ id: 'ayse@sirket.com', assurance: 'per-user-token', isUser: true })
  })

  it('depo yokken paylaşılan token servis kimliğine düşer', () => {
    const a = resolveActor('paylasilan', null, 'conarium_c2')
    expect(a).toEqual({ id: 'conarium_c2', assurance: 'shared-token', isUser: false })
  })

  it('depo VARKEN eşleşmeyen token kişi kimliği ÜRETMEZ', () => {
    const store = loadTokenStore(tokenFile([{ token: 'tok-ayse', id: 'ayse@sirket.com' }]))
    const a = resolveActor('baska-token', store, 'conarium_c2')
    expect(a.isUser).toBe(false)
    expect(a.assurance).toBe('shared-token')
  })

  it('CONARIUM_TOKENS_FILE her çağrıda okunur, modül yüklenirken değil', () => {
    // Sabit olarak yakalansaydı bu env değişikliği hiçbir şeyi etkilemezdi ve
    // geriye uyum testi sessizce yanlış şeyi ölçerdi.
    const onceki = process.env.CONARIUM_TOKENS_FILE
    try {
      process.env.CONARIUM_TOKENS_FILE = tokenFile([{ token: 'tok-x', id: 'x@sirket.com' }])
      expect(resolveActor('tok-x', loadTokenStore(), 'conarium_c2').id).toBe('x@sirket.com')

      process.env.CONARIUM_TOKENS_FILE = join(tmpdir(), 'cnr-yok-' + Date.now() + '.json')
      expect(loadTokenStore()).toBeNull()
    } finally {
      if (onceki === undefined) delete process.env.CONARIUM_TOKENS_FILE
      else process.env.CONARIUM_TOKENS_FILE = onceki
    }
  })

  it('bozuk JSON sessizce kimliği kapatmaz, hata fırlatır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-bozuk-'))
    const p = join(dir, 'conarium.tokens.json')
    writeFileSync(p, '{ bu gecerli json degil')
    expect(() => loadTokenStore(p)).toThrow(/bozuk JSON/)
  })

  it('depo dosyasında düz metin token bulunmaz', () => {
    const p = tokenFile([{ token: 'gizli-token-123', id: 'ayse@sirket.com' }])
    const ham = readFileSync(p, 'utf8')
    expect(ham).not.toContain('gizli-token-123')
  })
})
