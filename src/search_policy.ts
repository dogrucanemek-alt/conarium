import type { Connector, QueryResult, SchemaTable } from './types.js'
import { Governance, PolicyError } from './governance.js'

export const MIN_SEARCH_QUERY_LENGTH = 3
export const MAX_SEARCH_PAYLOAD_BYTES = 50000

export interface AuditLike {
  log(entry: {
    tool: string
    target?: string
    args?: unknown
    rowsReturned?: number
    denied: boolean
    reason?: string
  }): void
}

export function qualifiedTableName(table: SchemaTable): string {
  return `${table.schema}.${table.name}`
}

export async function resolveGovernedSearchScope(
  connector: Connector,
  governance: Governance,
  query: string,
  requestedTables?: string[]
): Promise<string[]> {
  const trimmed = query.trim()
  if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
    throw new PolicyError(`Search query must be at least ${MIN_SEARCH_QUERY_LENGTH} characters.`)
  }

  if (!governance.allowsConnector(connector.name)) {
    throw new PolicyError(`Search on connector '${connector.name}' is not permitted by policy.`)
  }

  const allowed = governance
    .filterTables(await connector.listTables())
    .map(qualifiedTableName)

  if (allowed.length === 0) {
    throw new PolicyError(`Search on connector '${connector.name}' has no allowed scope.`)
  }

  if (!requestedTables || requestedTables.length === 0) {
    return allowed
  }

  const allowedLookup = new Map(allowed.map(scope => [scope.toLowerCase(), scope]))
  const requested = requestedTables
    .map(scope => allowedLookup.get(scope.trim().toLowerCase()))
    .filter((scope): scope is string => Boolean(scope))

  if (requested.length === 0) {
    throw new PolicyError(`Search request has no tables permitted by policy.`)
  }

  return requested
}

export function capSearchResult(result: QueryResult, maxRows: number, maxBytes: number = MAX_SEARCH_PAYLOAD_BYTES): QueryResult {
  const capped = result.rows.slice(0, maxRows)
  const fits = (n: number) =>
    Buffer.byteLength(JSON.stringify({ ...result, rows: capped.slice(0, n), rowCount: n }), 'utf8') <= maxBytes

  // Binary search for the largest row-prefix under the byte cap: O(log n) size
  // measurements instead of O(n) (was pop-one-then-restringify-the-whole-list,
  // which blocks the event loop on large results).
  let lo = 0, hi = capped.length
  if (fits(hi)) {
    lo = hi
  } else {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid - 1
    }
  }
  const rows = capped.slice(0, lo)
  return { ...result, rows, rowCount: rows.length, fields: result.fields }
}

export async function readGovernedSchemaResource(
  connector: Connector,
  governance: Governance,
  audit: AuditLike,
  uri: string
): Promise<{ uri: string; mimeType: string; text: string }> {
  if (!governance.allowsConnector(connector.name)) {
    const reason = `Resource read on connector '${connector.name}' is not permitted by policy.`
    audit.log({ tool: 'read_resource', target: connector.name, args: { uri }, denied: true, reason })
    throw new PolicyError(reason)
  }

  const allowedTables = governance.filterTables(await connector.listTables())
  const detailed = []

  for (const table of allowedTables.slice(0, 30)) {
    const qualified = qualifiedTableName(table)
    if (!governance.allowsTable(qualified)) {
      const reason = `Access to table '${qualified}' is not permitted by policy.`
      audit.log({ tool: 'read_resource', target: connector.name, args: { uri, table: qualified }, denied: true, reason })
      throw new PolicyError(reason)
    }
    detailed.push(await connector.describeTable(qualified))
  }

  audit.log({ tool: 'read_resource', target: connector.name, args: { uri }, rowsReturned: detailed.length, denied: false })
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(detailed, null, 2),
  }
}
