/**
 * UÇTAN UCA: oturumun kimliği gerçekten denetim SATIRINA ulaşıyor mu?
 *
 * Bunu ayrıca test etmemin sebebi: buildServer -> kaydet -> audit.log zinciri
 * yalnızca tip kontrolünden geçmişti. "Derleniyor" ile "çalışıyor" aynı şey
 * değil; bu zincir sessizce kopsa denetim kaydı yine servis adı yazar ve
 * halka açık olarak kapattığımızı söylediğimiz açık aslında açık kalır.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type ConariumDeps } from './server.js'
import { Audit, type AuditEntry } from './audit.js'
import { Governance } from './governance.js'
import type { Connector, SchemaTable } from './types.js'

const PREV_UNSIGNED = process.env.CONARIUM_AUDIT_UNSIGNED
beforeAll(() => { process.env.CONARIUM_AUDIT_UNSIGNED = '1' })
afterAll(() => {
  if (PREV_UNSIGNED === undefined) delete process.env.CONARIUM_AUDIT_UNSIGNED
  else process.env.CONARIUM_AUDIT_UNSIGNED = PREV_UNSIGNED
})

/** Yazdigi satirlari bellekte tutan Audit — diske dokunmadan ne kaydedildigini gorur. */
class YakalayanAudit extends Audit {
  satirlar: AuditEntry[] = []
  log(entry: Parameters<Audit['log']>[0]): AuditEntry {
    const e = super.log(entry)
    this.satirlar.push(e)
    return e
  }
}

const sahteKonnektor: Connector = {
  name: 'test',
  description: 'test konnektoru',
  capabilities: { canQuery: true, canListSchema: true, canDescribeTable: true },
  connect: async () => {},
  disconnect: async () => {},
  listTables: async (): Promise<SchemaTable[]> => [{ name: 'musteriler', schema: 'public', columns: [] }],
  describeTable: async (t: string): Promise<SchemaTable> => ({ name: t, schema: 'public', columns: [] }),
  query: async () => ({ rows: [], rowCount: 0, columns: [] }),
  search: async () => ({ rows: [], rowCount: 0, columns: [] }),
}

function depsKur(audit: Audit): ConariumDeps {
  return {
    config: { serverName: 'test', consumer: 'conarium_c2', connectors: [] } as ConariumDeps['config'],
    // Konnektörler fail-closed: boş politika artık hiçbir
    // konnektöre erişemez. Bu testin konusu aktör kimliğinin denetim satırına
    // ulaşması; konnektörü açıkça izinli yapmak konuyu değiştirmez, sadece
    // testi yeni varsayılana göre kurar.
    governance: new Governance({ allowConnectors: [sahteKonnektor.name] }),
    audit,
    connectors: [sahteKonnektor],
  }
}

async function listTablesCagir(aktor?: { id: string; assurance: 'shared-token' | 'per-user-token'; isUser: boolean }) {
  const audit = new YakalayanAudit({ consumer: 'conarium_c2' })
  const server = buildServer(depsKur(audit), aktor)
  // Handler'i dogrudan cagir — tasima katmani bu testin konusu degil.
  const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown) => Promise<unknown>> })
    ._requestHandlers.get(CallToolRequestSchema.shape.method.value)
  if (!handler) throw new Error('CallTool handler bulunamadi — SDK ic yapisi degismis olabilir')
  // SDK istegi semayla dogruluyor: `method` sart, yoksa ZodError atar.
  await handler({ method: 'tools/call', params: { name: 'list_tables', arguments: {} } })
  return audit.satirlar
}

describe('oturum kimligi denetim satirina ulasiyor', () => {
  it('aktor verilmezse satir consumer ile yazilir (bugunku davranis)', async () => {
    const satirlar = await listTablesCagir(undefined)
    expect(satirlar.length).toBeGreaterThan(0)
    expect(satirlar[0].actor).toBe('conarium_c2')
    expect(satirlar[0].actorAssurance).toBe('shared-token')
  })

  it('kisi token ile acilan oturumda satir KISIYI yazar', async () => {
    const satirlar = await listTablesCagir({ id: 'ayse@sirket.com', assurance: 'per-user-token', isUser: true })
    expect(satirlar.length).toBeGreaterThan(0)
    expect(satirlar[0].actor).toBe('ayse@sirket.com')
    expect(satirlar[0].actorAssurance).toBe('per-user-token')
  })
})
