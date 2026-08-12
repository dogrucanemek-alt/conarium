/**
 * ARAÇ POLİTİKASI GERÇEKTEN ÇAĞRILIYOR MU?
 *
 * Bulgu (2026-08-12): `allowTools` / `denyTools` alanları `types.ts`'te belgeli,
 * konsolda düzenlenebilir ve `ApiGovernance.allowsTool` içinde testliydi — ama o
 * sınıf üretimde hiçbir yerden çağrılmıyordu. Yani operatör bir aracı kapattığını
 * sanıyor, çalışan sunucu bunu görmüyordu.
 *
 * Bu yüzden buradaki testler `allowsTool`'un DOĞRU çalıştığını ölçmüyor — o zaten
 * çalışıyordu. Ölçtükleri şey ÇAĞRILDIĞI: reddedilen araç dispatch akışında
 * duruyor mu, listede görünüyor mu, connector'a ulaşıyor mu. Bir sonraki sefer
 * kontrol yine akıştan düşerse bu dosya kırmızı yanar.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type ConariumDeps } from './server.js'
import { Audit, type AuditEntry } from './audit.js'
import { Governance } from './governance.js'
import type { Connector, GovernancePolicy, SchemaTable } from './types.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

class YakalayanAudit extends Audit {
  satirlar: AuditEntry[] = []
  log(entry: Parameters<Audit['log']>[0]): AuditEntry {
    const e = super.log(entry)
    this.satirlar.push(e)
    return e
  }
}

/** Kendisine ulaşılıp ulaşılmadığını sayan konnektör. */
function sayanKonnektor() {
  const sayac = { query: 0, listTables: 0, describeTable: 0 }
  const conn: Connector = {
    name: 'test',
    description: 'test konnektoru',
    capabilities: { canQuery: true, canListSchema: true, canDescribeTable: true },
    connect: async () => {},
    disconnect: async () => {},
    listTables: async (): Promise<SchemaTable[]> => { sayac.listTables++; return [{ name: 'musteriler', schema: 'public', columns: [] }] },
    describeTable: async (t: string): Promise<SchemaTable> => { sayac.describeTable++; return { name: t, schema: 'public', columns: [] } },
    query: async () => { sayac.query++; return { rows: [], rowCount: 0, columns: [] } },
    search: async () => ({ rows: [], rowCount: 0, columns: [] }),
  }
  return { conn, sayac }
}

function kur(policy: GovernancePolicy) {
  const { conn, sayac } = sayanKonnektor()
  const audit = new YakalayanAudit({ consumer: 'conarium_c2' })
  const deps: ConariumDeps = {
    config: { serverName: 'test', consumer: 'conarium_c2', connectors: [] } as ConariumDeps['config'],
    governance: new Governance({ allowConnectors: [conn.name], allowTables: ['public.*'], ...policy }),
    audit,
    connectors: [conn],
  }
  const server = buildServer(deps)
  const handlers = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })._requestHandlers
  return {
    sayac,
    audit,
    async cagir(name: string, args: Record<string, unknown> = {}) {
      const h = handlers.get(CallToolRequestSchema.shape.method.value)
      if (!h) throw new Error('CallTool handler bulunamadi — SDK ic yapisi degismis olabilir')
      return h({ method: 'tools/call', params: { name, arguments: args } })
    },
    async araclariListele(): Promise<string[]> {
      const h = handlers.get(ListToolsRequestSchema.shape.method.value)
      if (!h) throw new Error('ListTools handler bulunamadi')
      const sonuc = await h({ method: 'tools/list', params: {} }) as { tools: { name: string }[] }
      return sonuc.tools.map(t => t.name)
    },
  }
}

describe('denyTools dispatch akisinda gercekten uygulanir', () => {
  it('reddedilen arac connector\'a ULASMADAN durur', async () => {
    const s = kur({ denyTools: ['query'] })

    await expect(s.cagir('query', { sql: 'SELECT 1' })).rejects.toThrow(/not permitted by policy/)

    // Asil olcum: politika kontrolu once mu kosuyor. Reddedip yine de sorguyu
    // calistirmak, kapiyi kapatip pencereyi acik birakmaktir.
    expect(s.sayac.query).toBe(0)
  })

  it('reddedilen erisim girisimi denetim kaydina DUSER', async () => {
    const s = kur({ denyTools: ['query'] })
    await s.cagir('query', { sql: 'SELECT 1' }).catch(() => {})

    const satir = s.audit.satirlar.find(x => x.tool === 'query')
    expect(satir).toBeDefined()
    expect(satir!.denied).toBe(true)
    expect(satir!.reason).toBe('policy')
  })

  it('kapatilan arac ARAC LISTESINDE de gorunmez', async () => {
    const s = kur({ denyTools: ['query'] })
    const araclar = await s.araclariListele()

    expect(araclar).not.toContain('query')
    expect(araclar).toContain('list_tables')
  })

  it('glob kaliplari calisir', async () => {
    const s = kur({ denyTools: ['desc*'] })
    await expect(s.cagir('describe_table', { table: 'public.musteriler' })).rejects.toThrow(/not permitted/)
    expect(s.sayac.describeTable).toBe(0)
  })
})

describe('allowTools daraltma katmanidir, kapi degil', () => {
  it('allowTools verilirse listede olmayan arac reddedilir', async () => {
    const s = kur({ allowTools: ['list_tables'] })

    await expect(s.cagir('query', { sql: 'SELECT 1' })).rejects.toThrow(/not permitted/)
    expect(await s.araclariListele()).toEqual(['list_tables'])
  })

  it('politika verilmezse HICBIR arac kapanmaz — mevcut kurulumlar kirilmaz', async () => {
    // Bilerek fail-open: `allowsTable`/`allowsConnector` fail-closed, asil kapi
    // onlar. Burayi da fail-closed yapmak, allowTools yazmamis her kurulumu
    // sessizce kirardi — kapatmaya calistigimiz hatanin aynisi.
    const s = kur({})
    const araclar = await s.araclariListele()

    expect(araclar).toContain('query')
    expect(araclar).toContain('list_tables')
    await expect(s.cagir('list_tables', {})).resolves.toBeDefined()
    expect(s.sayac.listTables).toBe(1)
  })
})
