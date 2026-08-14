/**
 * Conarium server core — shared by stdio (index.ts) and remote HTTP (http.ts) entrypoints.
 * Behavior is identical to the original inline main(): same tools, same governance, same audit.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { ConariumConfig } from './types.js'
import type { Connector, ConnectorCapabilities } from './types.js'
import { createConnector } from './connectors/index.js'
import { Governance, PolicyError } from './governance.js'
import type { GovernanceMetadata } from './governance.js'
import { Audit } from './audit.js'
import type { ResolvedActor } from './tokens.js'
import { parseConariumConfig } from './config.js'
import { installedVersion } from './update-check.js'
import { capSearchResult, readGovernedSchemaResource, resolveGovernedSearchScope } from './search_policy.js'
import { SupabaseRestConnector } from './connectors/supabase_rest.js'

export interface ConariumDeps {
  config: ConariumConfig
  governance: Governance
  audit: Audit
  connectors: Connector[]
}

export function loadConfig(): ConariumConfig {
  const args = process.argv.slice(2)
  const configIdx = args.indexOf('--config')
  const configPath = configIdx >= 0 ? args[configIdx + 1] : 'conarium.config.json'
  const resolvedPath = resolve(process.cwd(), configPath)

  if (!existsSync(resolvedPath)) {
    return {
      serverName: 'Conarium',
      connectors: [],
    }
  }

  const raw = readFileSync(resolvedPath, 'utf-8')
  return parseConariumConfig(JSON.parse(raw))
}

/** Connect all configured connectors once (shared across sessions in HTTP mode). */
export async function bootDeps(config: ConariumConfig): Promise<ConariumDeps> {
  // `allowsConnector` is fail-closed. Without this guard the symptom
  // would be a server that starts fine and answers every request with "not
  // permitted" — the operator would blame their policy, not a changed default.
  // Name the missing field and the connectors it should list.
  const allowList = config.policy?.allowConnectors
  if (config.connectors.length > 0 && (!allowList || allowList.length === 0)) {
    const names = config.connectors.map((c) => c.name).join('", "')
    throw new Error(
      `Conarium: ${config.connectors.length} connector(s) are configured but policy.allowConnectors is empty. ` +
        `Connectors are fail-closed: an empty list permits nothing (it previously meant "allow all"). ` +
        `Add policy.allowConnectors: ["${names}"] to your config, or remove the connectors.`,
    )
  }

  const governance = new Governance(config.policy)
  const audit = new Audit({
    sink: config.audit?.sink,
    consumer: config.consumer,
    failClosed: config.audit?.failClosed,
    receiptSink: config.audit?.receiptSink,
    // v0.3: ikisi de opsiyonel. Eksik alan makbuzda `source: 'undeclared'` olur —
    // eskiden ikisi birden yoksa makbuz HİÇ üretilmiyordu.
    receiptMeta: {
      model: config.audit?.receiptModel,
      client: config.audit?.receiptClient,
    },
    scanCharCap: config.policy?.scanCharCap,
    detectors: config.policy?.detectors,
    customPatterns: config.policy?.customPatterns,
  })
  const connectors: Connector[] = []

  for (const cfg of config.connectors) {
    try {
      const conn = createConnector(cfg)
      await conn.connect()
      connectors.push(conn)
      console.error(`[conarium] Connected: ${cfg.name} (${cfg.type})`)
    } catch (err) {
      console.error(`[conarium] Failed to connect ${cfg.name}:`, (err as Error).message)
    }
  }

  if (connectors.length === 0) {
    console.error('[conarium] No connectors configured. Add a conarium.config.json file.')
  }

  return { config, governance, audit, connectors }
}

/**
 * Build an MCP Server wired to the shared deps. One instance per transport/session.
 *
 * `aktor`: bu OTURUMU açan kişi. Oturum tek token'la açıldığı için kimlik oturum
 * boyunca sabittir. Bilerek parametre — modül seviyesinde bir global kullanmak
 * eşzamanlı oturumlarda kimlikleri birbirine karıştırırdı ve denetim kaydı
 * yanlış kişiyi suçlardı. Verilmezse davranış eskisi gibi (consumer).
 */
export function buildServer(
  { config, governance: temelGovernance, audit, connectors }: ConariumDeps,
  aktor?: ResolvedActor,
): Server {
  // Maskeleme bu oturumu açan KİŞİYE göre çözülür. Profil yoksa, aktör yoksa ya da
  // paylaşılan token'sa taban politika döner — genişleme yönünde sessiz sapma yok.
  const governance = temelGovernance.forActor(aktor)
  // Oturumun kimliğini her denetim satırına TEK yerden geçir: audit.log çağrısı
  // bu dosyada 8+ yerde ve tek tek alan eklemek er geç birinde unutulur.
  //
  // Aynı yerden istemci kimliği de geçer. `getClientVersion()` MCP `initialize`
  // sırasında karşı tarafın BİLDİRDİĞİ değerdir — yani beyan değil, protokolden
  // ölçülmüş veri; makbuzda `source: 'protocol'` ile işaretlenir. Handshake henüz
  // olmadıysa undefined döner ve makbuz config beyanına ya da "bildirilmedi"ye düşer.
  const kaydet: typeof audit.log = (e) => {
    const ci = server.getClientVersion()
    return audit.log({
      ...e,
      ...(aktor ? { actor: aktor.id, actorAssurance: aktor.assurance } : {}),
      // Hangi maskeleme profili yürürlükteydi. Bu alan olmadan, profili olan bir
      // kişinin makbuzu profili olmayanınkiyle aynı görünür — imzalı ama eksik
      // beyan. Denetçinin sorduğu soru tam olarak budur: kime göre maskelendi.
      ...(governance.appliedProfile() ? { policyProfile: governance.appliedProfile()! } : {}),
      ...(ci?.name ? { client: { name: ci.name, version: ci.version ?? '', source: 'protocol' as const } } : {}),
    })
  }

  const server = new Server(
    {
      name: config.serverName || 'Conarium',
      version: config.serverVersion || installedVersion() || 'unknown',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_tables',
        description: 'List all database tables available in the company data connectors',
        inputSchema: {
          type: 'object',
          properties: {
            connector: { type: 'string', description: 'Connector name (optional, defaults to all)' },
          },
        },
      },
      {
        name: 'describe_table',
        description: 'Get the schema and column descriptions of a specific table',
        inputSchema: {
          type: 'object',
          required: ['table'],
          properties: {
            table: { type: 'string', description: 'Schema-qualified table name' },
            connector: { type: 'string', description: 'Connector name (optional)' },
          },
        },
      },
      {
        name: 'query',
        description: 'Run a read-only SQL query against the company database. Only SELECT is allowed.',
        inputSchema: {
          type: 'object',
          required: ['sql'],
          properties: {
            sql: { type: 'string', description: 'SQL SELECT query to execute' },
            connector: { type: 'string', description: 'Connector name (optional, defaults to first allowed)' },
          },
        },
      },
      {
        name: 'search',
        description: 'Full-text search across governed company data scopes',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search term' },
            tables: { type: 'array', items: { type: 'string' }, description: 'Schema-qualified search scopes' },
            connector: { type: 'string', description: 'Connector name (optional)' },
          },
        },
      },
    ].filter(t => governance.allowsTool(t.name)),
    // Politikayla kapatılan araç listede de görünmez. Aksi hâlde model aracı
    // görür, çağırır, reddedilir — kapalı olduğunu keşfetmenin tek yolu denemek
    // olurdu ve her deneme denetim kaydına gürültü yazardı.
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // Araç izni her şeyden ÖNCE: reddedilen araç connector'a, sorguya ya da ağa
    // hiç ulaşmasın. Denetim satırı yine düşer — reddedilen erişim de bir erişim
    // girişimidir ve makbuzun onu görmemesi, tam olarak bu ürünün kaçındığı
    // sessizlik olurdu.
    if (!governance.allowsTool(name)) {
      kaydet({ tool: name, args: args as Record<string, unknown>, denied: true, reason: 'policy' })
      throw new PolicyError(`Tool '${name}' is not permitted by policy.`)
    }

    const getConnector = (preferredName?: string, need?: keyof ConnectorCapabilities): Connector => {
      if (!connectors.length) throw new Error('No connectors available. Check your conarium.config.json.')
      if (preferredName) {
        const found = connectors.find(c => c.name === preferredName)
        if (!found) throw new Error(`Connector '${preferredName}' not found. Available: ${connectors.map(c => c.name).join(', ')}`)
        if (!governance.allowsConnector(found.name)) throw new PolicyError(`Connector '${found.name}' is not permitted by policy.`)
        return found
      }
      // Ad verilmediyse: aracin ihtiyacini (or. canQuery) karsilayan ilk izinli konnektore dus —
      // aksi halde SQL sorgusu docs gibi sorgu bilmeyen ilk konnektore gidip "Not supported" yiyor.
      const allowedAll = connectors.filter(c => governance.allowsConnector(c.name))
      const allowed = need ? (allowedAll.find(c => c.capabilities[need]) ?? allowedAll[0]) : allowedAll[0]
      if (!allowed) throw new PolicyError('No connector is permitted by policy.')
      return allowed
    }

    try {
      if (name === 'list_tables') {
        // Ad verilmediyse TUM izinli konnektorler listelenir — arac "all connectors" vaat ediyor,
        // ilkine dusmek cok-konnektorlu kurulumda gerisini gorunmez yapiyordu.
        const preferred = (args as Record<string, string>)?.connector
        const targets = preferred
          ? [getConnector(preferred)]
          : connectors.filter(c => governance.allowsConnector(c.name) && c.capabilities.canListSchema)
        if (!targets.length) throw new PolicyError('No connector is permitted by policy.')

        const listed: Array<{ connector: string; name: string; description: string; rowCount?: number }> = []
        for (const conn of targets) {
          const tables = governance.filterTables(await conn.listTables())
          kaydet({ tool: 'list_tables', target: conn.name, rowsReturned: tables.length, denied: false })
          for (const t of tables) {
            listed.push({
              connector: conn.name,
              name: `${t.schema}.${t.name}`,
              description: t.description || '',
              rowCount: t.rowCount,
            })
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(listed, null, 2) }],
        }
      }

      if (name === 'describe_table') {
        const a = args as { table: string; connector?: string }
        const conn = getConnector(a.connector, 'canDescribeTable')
        if (!governance.allowsTable(a.table)) {
          kaydet({ tool: 'describe_table', target: a.table, args: a, denied: true, reason: 'policy' })
          throw new PolicyError(`Access to table '${a.table}' is not permitted by policy.`)
        }
        const table = await conn.describeTable(a.table)
        kaydet({ tool: 'describe_table', target: a.table, args: a, denied: false })
        return {
          content: [{ type: 'text', text: JSON.stringify(table, null, 2) }],
        }
      }

      if (name === 'query') {
        const a = args as { sql: string; connector?: string }
        const conn = getConnector(a.connector, 'canQuery')

        let guardedSql = a.sql
        let aliases: Record<string, string> = {}
        let guardMetadata: GovernanceMetadata | undefined
        let result

        // PostgREST path: no Postgres AST rewrite (would break MSSQL/REST simple SELECT).
        if (conn instanceof SupabaseRestConnector) {
          let parsed
          try {
            parsed = conn.parseSimpleSelect(a.sql)
          } catch (err) {
            kaydet({ tool: 'query', args: { sql: a.sql }, denied: true, reason: (err as Error).message })
            throw err
          }
          // Sema konnektorun yapilandirmasindan gelir — sabit 'zion' varsayimi baska semali
          // kurulumlarda (demo, musteri tenant'i) her sorguyu yanlislikla policy'ye takiyordu.
          const schema = conn.schemaName
          const qualified = `${schema}.${parsed.table}`
          if (!governance.allowsTable(qualified)) {
            kaydet({ tool: 'query', target: qualified, args: a, denied: true, reason: 'policy' })
            throw new PolicyError(`Access to table '${qualified}' is not permitted by policy.`)
          }
          const lim = Math.min(parsed.limit, governance.maxRows())
          guardedSql = `SELECT ${parsed.columns.join(', ')} FROM ${schema}.${parsed.table} LIMIT ${lim}`
          guardMetadata = {
            accessedTables: [qualified],
            accessedFunctions: [],
            appliedRowCap: lim,
            maskedFields: [],
            maskedCount: 0,
            denied: false,
          }
          result = governance.redact(await conn.query(guardedSql), aliases, guardMetadata)
        } else {
          try {
            const res = governance.guardQuery(a.sql)
            guardedSql = res.sql
            aliases = res.aliases
            guardMetadata = res.metadata
          } catch (err) {
            const policyMetadata = err instanceof PolicyError ? err.metadata : undefined
            kaydet({ tool: 'query', args: { sql: a.sql }, denied: true, reason: (err as Error).message, governance: policyMetadata })
            throw err
          }
          result = governance.redact(await conn.query(guardedSql), aliases, guardMetadata)
        }

        const cap = governance.maxRows()
        const responseJson = JSON.stringify(
          {
            rowCount: result.rowCount,
            fields: result.fields,
            rows: result.rows.slice(0, cap),
            truncated: result.rowCount > cap,
          },
          null,
          2
        )

        if (Buffer.byteLength(responseJson, 'utf8') > 50000) {
          const limitErr = new Error('Response payload exceeds 50KB limit. Aggregation or massive row detected.')
          kaydet({
            tool: 'query',
            target: conn.name,
            args: { sql: a.sql },
            denied: true,
            reason: limitErr.message,
            governance: { ...result.governance, denied: true, denyReason: limitErr.message },
          })
          throw limitErr
        }

        kaydet({
          tool: 'query',
          target: conn.name,
          args: { sql: a.sql },
          rowsReturned: Math.min(result.rowCount, cap),
          maskedCount: result.governance.maskedCount,
          denied: false,
          governance: result.governance,
        })

        return {
          content: [{ type: 'text', text: responseJson }],
        }
      }

      if (name === 'search') {
        const a = args as { query: string; tables?: string[]; connector?: string }
        const conn = getConnector(a.connector, 'canSearch')
        let requested: string[]

        try {
          requested = await resolveGovernedSearchScope(conn, governance, a.query, a.tables)
        } catch (err) {
          kaydet({ tool: 'search', target: conn.name, args: a, denied: true, reason: (err as Error).message })
          throw err
        }

        const capped = capSearchResult(await conn.search(a.query, requested), governance.maxRows())
        const result = governance.redact(capped)
        // Arama sonucunun GERÇEKTEN dokunduğu tabloları satırlardaki _table'dan topla.
        // entry.target konnektör adıdır (tablo değil) — onu makbuza nesne olarak yazmak
        // yanlış veri olur. Sonuç satırları _table taşıyorsa onları kaydet; taşımıyorsa
        // boş bırak (kapsama "bilinmiyor" sayacına düşer — uydurma yok).
        const searchTables = [...new Set(result.rows.map((r) => (r as Record<string, unknown>)._table).filter(Boolean))] as string[]
        const searchGovernance = searchTables.length
          ? { ...result.governance, accessedTables: searchTables }
          : result.governance
        kaydet({
          tool: 'search',
          target: conn.name,
          args: a,
          rowsReturned: result.rowCount,
          denied: false,
          governance: searchGovernance,
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
      }

      throw new Error(`Unknown tool: ${name}`)
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: connectors.filter(conn => governance.allowsConnector(conn.name)).map(conn => ({
      uri: `conarium://${conn.name}/schema`,
      name: `${conn.name} schema`,
      description: conn.description,
      mimeType: 'application/json',
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    const connName = uri.replace('conarium://', '').replace('/schema', '')
    const conn = connectors.find(c => c.name === connName)
    if (!conn) throw new Error(`Connector not found: ${connName}`)
    const content = await readGovernedSchemaResource(conn, governance, audit, uri)
    return { contents: [content] }
  })

  return server
}
