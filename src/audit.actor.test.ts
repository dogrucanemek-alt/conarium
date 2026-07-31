import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Audit } from './audit.js'

// Imzasiz calis: burada olculen sey kimlik alani, imza degil.
const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => {
  process.env.CONARIUM_AUDIT_UNSIGNED = '1'
})
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

describe('denetim kaydi aktoru', () => {
  it('aktor verilmezse consumer kullanilir — bugunku davranis aynen korunur', () => {
    const a = new Audit({ consumer: 'conarium_c2' })
    const e = a.log({ tool: 'query', denied: false })
    expect(e.actor).toBe('conarium_c2')
    expect(e.actorAssurance).toBe('shared-token')
  })

  it('aktor verilirse kisi adi yazilir ve guvence beyan edilir', () => {
    const a = new Audit({ consumer: 'conarium_c2' })
    const e = a.log({
      tool: 'query',
      denied: false,
      actor: 'ayse@sirket.com',
      actorAssurance: 'per-user-token',
    })
    expect(e.actor).toBe('ayse@sirket.com')
    expect(e.actorAssurance).toBe('per-user-token')
  })

  it('aktor hash zincirine dahildir — sonradan degistirilirse zincir kirilir', () => {
    // Iki ayri Audit ornegi, ayni ilk satir disinda her sey esit: yalniz aktor farkli.
    // Hash'ler farkli cikmali, yoksa kimlik "kayit disi" demektir ve makbuz bir sey kanitlamaz.
    const a1 = new Audit({ consumer: 'c' })
    const h1 = a1.log({ tool: 'query', denied: false, actor: 'ayse@x.com', actorAssurance: 'per-user-token' }).hash
    const a2 = new Audit({ consumer: 'c' })
    const h2 = a2.log({ tool: 'query', denied: false, actor: 'mehmet@x.com', actorAssurance: 'per-user-token' }).hash
    expect(h1).toBeTruthy()
    expect(h1).not.toBe(h2)
  })

  it('guvence de hash zincirine dahildir — "user" iddiasi kayit disi guclendirilemez', () => {
    const a1 = new Audit({ consumer: 'c' })
    const h1 = a1.log({ tool: 'query', denied: false, actor: 'ayse@x.com', actorAssurance: 'shared-token' }).hash
    const a2 = new Audit({ consumer: 'c' })
    const h2 = a2.log({ tool: 'query', denied: false, actor: 'ayse@x.com', actorAssurance: 'per-user-token' }).hash
    expect(h1).not.toBe(h2)
  })
})
