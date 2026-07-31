/**
 * KONNEKTÖR FAIL-CLOSED (v0.3) — kilit testleri.
 *
 * v0.3'te `Governance.allowsConnector` ve `bootDeps` fail-closed oldu:
 *   - `policy.allowConnectors` yazılmamışsa / boşsa HİÇBİR konnektöre izin YOK
 *     (eskiden boş liste "hepsine izin" demekti).
 *   - `bootDeps` artık konnektör yapılandırılmış ama allowConnectors boşsa
 *     sunucunun ayakta kalıp her isteğe "not permitted" demesine izin vermiyor;
 *     adıyla hata fırlatıyor. Sebep: sessiz kırıcı değişiklikte operatör kendi
 *     politikasını suçlar, değişen varsayılanı değil.
 *
 * Bu testler yeni davranışı kilitler: sessiz izin yok, mesaj yardımcı, deny
 * allow'dan önce gelir, boş kurulum meşru.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Governance } from './governance.js'
import { bootDeps } from './server.js'

// bootDeps bir Audit kurar; Audit anahtarsız yazmayı reddeder (fail-closed).
// Bu dosyanın konusu konnektör izni, imza değil — server.actor.test.ts'teki
// desenin aynısıyla imzasız moda izin verip sonra eski değeri geri koyuyoruz.
const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})
import type { ConariumConfig } from './types.js'

// Gerçek bir connector'a bağlanmadan guard'ı test etmek için config'de yeterli
// bir connector tanımı. bootDeps guard'ı connector'a DOKUNMADAN önce throw eder,
// yani type'ın gerçekten bağlanabilir olması gerekmez — sadece "var" olması yeter.
function configIle(connectors: ConariumConfig['connectors'], policy?: ConariumConfig['policy']): ConariumConfig {
  return {
    serverName: 'test',
    consumer: 'conarium_c2',
    connectors,
    policy,
  }
}

const birKonnektor: ConariumConfig['connectors'] = [
  { type: 'files', name: 'muhasebe', description: 'muhasebe dosyalari', config: {} },
]

const ikiKonnektor: ConariumConfig['connectors'] = [
  { type: 'files', name: 'muhasebe', description: 'muhasebe dosyalari', config: {} },
  { type: 'files', name: 'insankaynaklari', description: 'ik dosyalari', config: {} },
]

describe('Governance.allowsConnector — fail-closed varsayilan', () => {
  it('allowConnectors yazilmamissa HICBIR konnektore izin vermez (fail-closed)', () => {
    const g = new Governance({}) // allowConnectors yok
    expect(g.allowsConnector('muhasebe')).toBe(false)
    expect(g.allowsConnector('herhangi-bir-ad')).toBe(false)
  })

  it('allowConnectors bos dizi ise HICBIR konnektore izin vermez', () => {
    const g = new Governance({ allowConnectors: [] })
    expect(g.allowsConnector('muhasebe')).toBe(false)
  })

  it('allowConnectors yazilmis ise yalnizca listedekiler gecer', () => {
    const g = new Governance({ allowConnectors: ['muhasebe'] })
    expect(g.allowsConnector('muhasebe')).toBe(true)
    expect(g.allowsConnector('insankaynaklari')).toBe(false) // listede yok -> reddedilir
  })

  it('glob deseni calisir (prefix + wildcard)', () => {
    const g = new Governance({ allowConnectors: ['muhasebe*'] })
    expect(g.allowsConnector('muhasebe')).toBe(true)
    expect(g.allowsConnector('muhasebe-prod')).toBe(true)
    expect(g.allowsConnector('insankaynaklari')).toBe(false)
  })

  it('denyConnectors allowConnectors\'tan ONCE gelir (deny kazanir) — regresyon', () => {
    const g = new Governance({
      allowConnectors: ['muhasebe', 'insankaynaklari'],
      denyConnectors: ['muhasebe'],
    })
    // deny listesindeki reddedilir
    expect(g.allowsConnector('muhasebe')).toBe(false)
    // deny listesinde olmayan, allow listesinde olan gecer
    expect(g.allowsConnector('insankaynaklari')).toBe(true)
  })

  it('denyConnectors tek basina da calisir (allow yoksa her sey deny ile filtrelenir)', () => {
    const g = new Governance({ denyConnectors: ['muhasebe'] })
    expect(g.allowsConnector('muhasebe')).toBe(false)
    // allowConnectors yok + deny var -> fail-closed: yine hicbir sey gecmez
    expect(g.allowsConnector('insankaynaklari')).toBe(false)
  })
})

describe('bootDeps — konnektor varken allowConnectors bos ise ayaga kalkmaz', () => {
  it('konnektor var + allowConnectors yok -> THROW eder (sessiz izin YOK)', async () => {
    const cfg = configIle(birKonnektor) // policy yok
    await expect(bootDeps(cfg)).rejects.toThrow()
  })

  it('hata mesaji eksik alan adini (policy.allowConnectors) icerir', async () => {
    const cfg = configIle(birKonnektor)
    await expect(bootDeps(cfg)).rejects.toThrow(/policy\.allowConnectors/)
  })

  it('hata mesaji konnektor adlarini icerir (yardimci mesaj ozelligin parcasi)', async () => {
    const cfg = configIle(ikiKonnektor)
    await expect(bootDeps(cfg)).rejects.toThrow(/muhasebe/)
    await expect(bootDeps(cfg)).rejects.toThrow(/insankaynaklari/)
  })

  it('hata mesaji konnektor sayisini icerir', async () => {
    const cfg = configIle(ikiKonnektor)
    await expect(bootDeps(cfg)).rejects.toThrow(/2 connector/)
  })

  it('konnektor var + allowConnectors bos dizi -> THROW eder', async () => {
    const cfg = configIle(birKonnektor, { allowConnectors: [] })
    await expect(bootDeps(cfg)).rejects.toThrow(/policy\.allowConnectors/)
  })

  it('konnektor HIC yoksa + allowConnectors yok -> hata VERMEZ (bos kurulum mesru)', async () => {
    const cfg = configIle([]) // connector yok, policy yok
    // bootDeps connector'a dokunmadan dondurur; hata firlatmamali.
    // (connectors: [] oldugu icin guard tetiklenmez.)
    const deps = await bootDeps(cfg)
    expect(deps.connectors).toEqual([])
  })
})
