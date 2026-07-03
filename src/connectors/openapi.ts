import type {
  Connector,
  ConnectorConfig,
  SchemaTable,
  SchemaColumn,
  QueryResult,
  ConnectorCapabilities,
} from '../types.js'
import fetch from 'node-fetch'
import fs from 'fs/promises'
import dns from 'dns/promises'
import net from 'net'

interface EndpointInfo {
  method: string
  path: string
  name: string
  summary?: string
  description?: string
  parameters?: any[]
  requestBody?: any
  responses?: any
}

export class OpenApiConnector implements Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities = {
    canQuery: true,
    canListSchema: true,
    canDescribeTable: true,
    canSearch: true,
  }

  private config: ConnectorConfig
  private endpoints: EndpointInfo[] = []
  private openApiDoc: any = null
  private specOrigin?: string

  constructor(config: ConnectorConfig) {
    this.config = config
    this.name = config.name
    this.description = config.description
  }

  async connect(): Promise<void> {
    const url = this.config.config.url
    if (!url) {
      throw new Error(`${this.name}: 'url' required in connector config`)
    }

    let doc: any

    if (this.isHttpUrl(url)) {
      await this.enforceSafeRemoteUrl(url, 'OpenAPI spec')
      this.specOrigin = new URL(url).origin
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)

      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) {
          throw new Error(`${this.name}: Failed to fetch OpenAPI spec from ${url}: ${res.statusText}`)
        }
        doc = await res.json()
      } finally {
        clearTimeout(timeoutId)
      }
    } else {
      const raw = await fs.readFile(url, 'utf8')
      doc = JSON.parse(raw)
    }

    this.openApiDoc = doc

    const paths = doc.paths || {}
    this.endpoints = []

    for (const path of Object.keys(paths)) {
      const pathItem = paths[path]
      const pathParameters = pathItem.parameters || []
      for (const method of Object.keys(pathItem)) {
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'].includes(method.toLowerCase())) {
          const operation = pathItem[method]
          const methodUpper = method.toUpperCase()
          const name = `${methodUpper} ${path}`
          const mergedParams = [
            ...pathParameters,
            ...(operation.parameters || [])
          ]
          this.endpoints.push({
            method: methodUpper,
            path,
            name,
            summary: operation.summary,
            description: operation.description,
            parameters: mergedParams,
            requestBody: operation.requestBody,
            responses: operation.responses,
          })
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.endpoints = []
    this.openApiDoc = null
  }

  async listTables(): Promise<SchemaTable[]> {
    return this.endpoints.map(ep => ({
      name: ep.name,
      schema: 'api',
      columns: [],
      description: ep.summary || ep.description || `${ep.method} ${ep.path}`,
    }))
  }

  async describeTable(table: string): Promise<SchemaTable> {
    const name = this.normalizeTableName(table)
    const ep = this.endpoints.find(e => e.name === name)
    if (!ep) {
      throw new Error(`${this.name}: Table (endpoint) '${table}' not found`)
    }

    const columns: SchemaColumn[] = []

    // 1. Parameters (query, path, header, cookie)
    if (ep.parameters) {
      for (const param of ep.parameters) {
        const resolvedParam = this.resolveRef(param)
        const paramType = resolvedParam.schema ? this.getSchemaTypeString(resolvedParam.schema) : 'any'
        columns.push({
          name: `param:${resolvedParam.name}`,
          type: `${resolvedParam.in || 'query'} ${paramType}`,
          nullable: !resolvedParam.required,
          isPrimary: resolvedParam.in === 'path',
          isForeign: false,
          description: resolvedParam.description || undefined,
        })
      }
    }

    // 2. Request body
    if (ep.requestBody) {
      const body = this.resolveRef(ep.requestBody)
      const content = body.content || {}
      const jsonContent = content['application/json'] || Object.values(content)[0] as any
      if (jsonContent && jsonContent.schema) {
        const schema = this.resolveRef(jsonContent.schema)
        if (schema.type === 'object' && schema.properties) {
          for (const propName of Object.keys(schema.properties)) {
            const prop = this.resolveRef(schema.properties[propName])
            const required = Array.isArray(schema.required) && schema.required.includes(propName)
            columns.push({
              name: `body:${propName}`,
              type: `body ${this.getSchemaTypeString(prop)}`,
              nullable: !required,
              isPrimary: false,
              isForeign: false,
              description: prop.description || undefined,
            })
          }
        } else {
          columns.push({
            name: 'body',
            type: `body ${this.getSchemaTypeString(schema)}`,
            nullable: !body.required,
            isPrimary: false,
            isForeign: false,
            description: body.description || schema.description || undefined,
          })
        }
      }
    }

    // 3. Response body properties
    if (ep.responses) {
      const okResponseKey = Object.keys(ep.responses).find(status => status.startsWith('2')) || 'default'
      const response = this.resolveRef(ep.responses[okResponseKey])
      if (response && response.content) {
        const content = response.content
        const jsonContent = content['application/json'] || Object.values(content)[0] as any
        if (jsonContent && jsonContent.schema) {
          const schema = this.resolveRef(jsonContent.schema)
          if (schema.type === 'object' && schema.properties) {
            for (const propName of Object.keys(schema.properties)) {
              const prop = this.resolveRef(schema.properties[propName])
              columns.push({
                name: `response:${propName}`,
                type: `response ${this.getSchemaTypeString(prop)}`,
                nullable: true,
                isPrimary: false,
                isForeign: false,
                description: prop.description || undefined,
              })
            }
          } else {
            columns.push({
              name: 'response',
              type: `response ${this.getSchemaTypeString(schema)}`,
              nullable: true,
              isPrimary: false,
              isForeign: false,
              description: response.description || schema.description || undefined,
            })
          }
        }
      }
    }

    return {
      name: ep.name,
      schema: 'api',
      columns,
      rowCount: 1,
      description: ep.summary || ep.description || undefined,
    }
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    let input = sql.trim()

    // Handle wrapping SELECT queries from tools: SELECT * FROM "api"."GET /users"
    if (input.toUpperCase().startsWith('SELECT') || input.toUpperCase().startsWith('WITH')) {
      const fromMatch = input.match(/FROM\s+(.+?)(?:\s+(?:WHERE|LIMIT|ORDER|GROUP|JOIN|LEFT|RIGHT|INNER|ON|UNION)|;|$)/i)
      if (fromMatch) {
        const rawTableRef = fromMatch[1].trim()
        let tableName = rawTableRef
        if (rawTableRef.includes('.')) {
          const parts = rawTableRef.split('.').map(p => p.trim().replace(/^"|"$/g, ''))
          tableName = parts[parts.length - 1]
        } else {
          tableName = rawTableRef.replace(/^"|"$/g, '')
        }
        input = tableName
      }
    }

    const spaceIdx = input.indexOf(' ')
    if (spaceIdx === -1) {
      throw new Error(`Invalid query input format. Expected "METHOD path" (e.g., "GET /users"), got: "${sql}"`)
    }

    const method = input.slice(0, spaceIdx).trim().toUpperCase()
    const rawPath = input.slice(spaceIdx + 1).trim()

    if (method !== 'GET') {
      throw new Error(`Write operations are not allowed. Only GET is allowed. Method requested: ${method}`)
    }

    const rawPathWithoutQuery = rawPath.split('?')[0]
    let matchedEndpoint = this.endpoints.find(e => e.method === method && e.path === rawPathWithoutQuery)
    if (!matchedEndpoint) {
      for (const ep of this.endpoints) {
        if (ep.method !== method) continue
        const pattern = '^' + ep.path.replace(/\{[^}]+\}/g, '([^/]+)') + '$'
        if (new RegExp(pattern).test(rawPathWithoutQuery)) {
          matchedEndpoint = ep
          break
        }
      }
    }
    if (!matchedEndpoint) {
      throw new Error(`endpoint not in spec: ${method} ${rawPathWithoutQuery}`)
    }

    const baseUrlStr = await this.getBaseUrl()
    let fullUrl = baseUrlStr
    if (fullUrl.endsWith('/')) {
      fullUrl = fullUrl.slice(0, -1)
    }
    let pathStr = rawPath
    if (!pathStr.startsWith('/')) {
      pathStr = '/' + pathStr
    }
    const urlToFetch = `${fullUrl}${pathStr}`

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }

    if (this.config.config.headers) {
      try {
        const customHeaders = JSON.parse(this.config.config.headers)
        Object.assign(headers, customHeaders)
      } catch {
        // ignore invalid JSON headers
      }
    }

    if (this.config.config.token || this.config.config.apiKey) {
      const authVal = this.config.config.token || this.config.config.apiKey
      headers['Authorization'] = authVal.startsWith('Bearer ') ? authVal : `Bearer ${authVal}`
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    let res
    try {
      await this.enforceSafeRemoteUrl(urlToFetch, 'OpenAPI request')
      res = await fetch(urlToFetch, { headers, signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      throw new Error(`API Request to ${urlToFetch} failed: ${res.status} ${res.statusText}`)
    }

    const resJson = await res.json()
    let rows: Record<string, unknown>[] = []
    if (Array.isArray(resJson)) {
      rows = resJson.map(item => typeof item === 'object' && item !== null ? item as Record<string, unknown> : { value: item })
    } else if (typeof resJson === 'object' && resJson !== null) {
      rows = [resJson as Record<string, unknown>]
    } else {
      rows = [{ value: resJson }]
    }

    return {
      rows,
      rowCount: rows.length,
      fields: rows.length > 0 ? Object.keys(rows[0]) : [],
      sql,
    }
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    const q = query.toLowerCase()
    const targetNames = tables?.map(t => this.normalizeTableName(t))
    const pool = targetNames?.length
      ? this.endpoints.filter(e => targetNames.includes(e.name))
      : this.endpoints

    const scored = pool
      .map(ep => {
        let score = 0
        if (ep.name.toLowerCase().includes(q)) score += 10
        if (ep.summary?.toLowerCase().includes(q)) score += 5
        if (ep.description?.toLowerCase().includes(q)) score += 3
        return { score, ep }
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)

    const rows = scored.map(s => ({
      _table: `api.${s.ep.name}`,
      method: s.ep.method,
      path: s.ep.path,
      summary: s.ep.summary || '',
      description: s.ep.description || '',
    }))

    return {
      rows,
      rowCount: rows.length,
      fields: rows.length > 0 ? Object.keys(rows[0]) : [],
    }
  }

  private normalizeTableName(table: string): string {
    let clean = table.trim()
    if (clean.toLowerCase().startsWith('api.')) {
      clean = clean.slice(4)
    }
    clean = clean.replace(/^"|"$/g, '')
    return clean
  }

  private resolveRef(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj
    if ('$ref' in obj && typeof obj.$ref === 'string') {
      const ref = obj.$ref
      if (ref.startsWith('#/')) {
        const parts = ref.slice(2).split('/')
        let current = this.openApiDoc
        for (const part of parts) {
          if (current && typeof current === 'object' && part in current) {
            current = current[part]
          } else {
            return obj
          }
        }
        return this.resolveRef(current)
      }
    }
    return obj
  }

  private getSchemaTypeString(schema: any): string {
    if (!schema) return 'any'
    schema = this.resolveRef(schema)
    if (schema.type) {
      if (schema.type === 'array' && schema.items) {
        const itemsSchema = this.resolveRef(schema.items)
        return `array<${this.getSchemaTypeString(itemsSchema)}>`
      }
      return schema.type
    }
    if (schema.properties) return 'object'
    if (schema.oneOf || schema.anyOf || schema.allOf) return 'union'
    return 'any'
  }

  private async getBaseUrl(): Promise<string> {
    if (this.config.config.baseUrl) {
      await this.enforceSafeRemoteUrl(this.config.config.baseUrl, 'OpenAPI base URL')
      return this.config.config.baseUrl
    }

    if (this.specOrigin) {
      return this.specOrigin
    }

    throw new Error(`${this.name}: config.baseUrl is required when the OpenAPI spec is loaded from a local file.`)
  }

  private isHttpUrl(value: string): boolean {
    return value.startsWith('http://') || value.startsWith('https://')
  }

  private allowedBaseUrls(): URL[] {
    const raw = this.config.config.allowedBaseUrls
    if (!raw) {
      throw new Error(`${this.name}: config.allowedBaseUrls is required for remote OpenAPI URLs.`)
    }
    return raw.split(',').map(item => new URL(item.trim())).filter(Boolean)
  }

  private isAllowedByConfig(url: URL): boolean {
    return this.allowedBaseUrls().some(allowed => {
      if (url.origin !== allowed.origin) return false
      const prefix = allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`
      return allowed.pathname === '/' || url.pathname === allowed.pathname || url.pathname.startsWith(prefix)
    })
  }

  private async enforceSafeRemoteUrl(rawUrl: string, purpose: string): Promise<void> {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') {
      throw new Error(`${this.name}: ${purpose} must use HTTPS.`)
    }
    if (!this.isAllowedByConfig(parsed)) {
      throw new Error(`${this.name}: ${purpose} '${rawUrl}' is not in config.allowedBaseUrls.`)
    }

    const addresses = await this.resolveHost(parsed.hostname)
    for (const address of addresses) {
      if (this.isPrivateOrReservedIp(address)) {
        throw new Error(`${this.name}: ${purpose} resolves to blocked private/reserved address ${address}.`)
      }
    }
  }

  private async resolveHost(hostname: string): Promise<string[]> {
    if (net.isIP(hostname)) return [hostname]
    const records = await dns.lookup(hostname, { all: true })
    return records.map(record => record.address)
  }

  private isPrivateOrReservedIp(address: string): boolean {
    const family = net.isIP(address)
    if (family === 4) {
      const parts = address.split('.').map(Number)
      const [a, b, c, d] = parts
      return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0)
        || (a === 192 && b === 0 && c === 2)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224
        || (a === 255 && b === 255 && c === 255 && d === 255)
    }
    if (family === 6) {
      const normalized = address.toLowerCase()
      return normalized === '::'
        || normalized === '::1'
        || normalized.startsWith('fe80:')
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
    }
    return true
  }
}
